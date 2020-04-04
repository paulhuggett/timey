#!/usr/bin/env node
/*eslint quotes: ["error", "single"]*/

'use strict';

const async = require ('async');
const fs = require ('fs');
const glob = require ('glob-promise');
const os = require ('os');
const path = require ('path');
const {promisify} = require ('util');
const yargs = require ('yargs');

const run = require ('./run');

/**
 * @param work_dir{string}  The directory used for intermediate files.
 * @returns {string} A glob pattern which will match the ticket files generated by rld-gen.
 */
function all_tickets_pattern (work_dir) {
    return path.join (work_dir, '*.o');
}

/**
 * Deletes the intermediate ticket, ELF, and repo database files from the working directory.
 *
 * @param work_dir{string}  The directory which will be used for intermediate files.
 * @param repo_name{string}  The name of the program repository database.
 * @returns {Promise<*>} A promise which is resolved once all of the intermediate files have been deleted.
 */
function clean_all (work_dir, repo_name) {
    const clean = (pattern) => {
        return glob (pattern)
            .then ((contents) => contents.forEach (file => fs.unlinkSync (file)));
    };
    return clean (all_tickets_pattern (work_dir))
        .then (() => clean (path.join (work_dir, '*.o.elf')))
        .then (() => clean (path.join (work_dir, repo_name)));
}

const is_repo_linker = true;
const verbose = true;
const repo_name = 'repository.db';

/**
 * @param bin_dir{string}  The directory containing the LLVM executables.
 * @param work_dir{string}  The directory which will be used for intermediate files.
 * @param num_modules{Number}  The number of modules (ticket files) to be produced.
 * @param num_external_symbols{Number}  The number of external symbols per module.
 * @param num_linkonce_symbols{Number}  The number of linkonce symbols per module.
 */
function single_run (bin_dir, work_dir, num_modules, num_external_symbols, num_linkonce_symbols) {
    const r = run.runner (bin_dir, work_dir, repo_name, verbose);
    return clean_all (work_dir, repo_name)
        .then (() => r.rld_gen (num_modules, num_external_symbols, num_linkonce_symbols))
        .then (() => glob (all_tickets_pattern (work_dir)))
        .then (ticket_files => {
            if (is_repo_linker) {
                // Just pass on the ticket files.
                return ticket_files;
            }

            // Run repo2obj to convert each ticket file to an ELF object file for input to a traditional linker.
            return async.mapLimit (ticket_files, os.cpus ().length, function (ticket_file, callback) {
                const elf_file = ticket_file + '.elf';
                r.repo2obj (ticket_file, elf_file)
                    .then (() => callback (null, elf_file))
                    .catch (callback);
            });
        })
        .then (ld_inputs => {
            const start = Date.now ();
            return (is_repo_linker ? r.rld : r.lld) (ld_inputs, path.join (work_dir, 'a.out'))
                .then (() => Date.now () - start)
                .catch (err => { throw err; });
        });
}

/**
 * Checks whether the given directory is both a directory and, unless force is true, empty. If not, an error is raised.
 * @param work_dir{string}  The directory to be checked.
 * @param force{boolean}  If true avoids an error if the directory is not empty.
 * @returns {Promise<boolean>}
 */
function check_work_directory (work_dir, force) {
    return promisify (fs.stat) (work_dir)
        .then (stats => {
            if (!stats.isDirectory ()) {
                throw new Error ('The specified work directory is not a directory');
            }
            return promisify (fs.readdir) (work_dir);
        })
        .then (files => {
            if (files.length > 0 && !force) {
                throw new Error ('The specified work directory was not empty (--force to continue anyway)');
            }
            return true;
        });
}

/**
 * Accepts an array full of "tasks" (functions which take no arguments and return a promise of a result). Returns
 * a single promise of an array of results from those tasks which are executed serially.
 *
 * @param tasks{Array<function>}
 * @returns {Promise<Array<results>>}
 */
function serialize_tasks (tasks) {
    return tasks.reduce ((promise_chain, item) => {
        return promise_chain.then (chain_results => item ().then (result => [...chain_results, result]));
    }, Promise.resolve ([]));
}

function main () {
    const argv = yargs.usage ('Usage: $0 path')
        .strict ()
        .default ('work-dir', os.tmpdir ())
        .describe ('work-dir', 'The directory to be used for intermediate (work) files.')
        .default ('bin-dir', '/usr/bin')
        .describe ('bin-dir', 'The directory containing LLVM executables')
        .default ('o', '-')
        .describe ('o', 'The file to which the results will be written')
        .alias ('o', 'output')
        .boolean ('f')
        .default ('f', false)
        .describe ('f', 'Continue even if the work directory is not empty')
        .alias ('f', 'force')
        .boolean ('debug')
        .default ('debug', false)
        .default ('increment', 1000)
        .describe ('increment', 'The number by which the symbol counts are incremented on each run')
        .default ('external', 2000)
        .describe ('external', 'The number of external symbols defined by each module')
        .default ('linkonce', 2000)
        .describe ('linkonce', 'The number of linkonce symbols defined by each module')
        .default ('modules', 10)
        .describe ('modules', 'The number of modules to be created')
        .help ('h')
        .alias ('h', 'help')
        .argv;

    check_work_directory (argv.workDir, argv.force)
        .then (() => {
            const lomax = argv.linkonce;
            const extmax = argv.external;
            const incr = argv.increment;
            return serialize_tasks (Array (Math.floor ((lomax * extmax) / (incr * incr)))
                .fill (undefined)
                .map ((_, i) => {
                    const num_external = (Math.floor (i / (lomax / incr)) + 1) * incr;
                    const num_linkonce = (i % (lomax / incr) + 1) * incr;
                    return () => single_run (argv.binDir, argv.workDir, argv.modules, num_external, num_linkonce)
                        .then (time => [num_external, num_linkonce, time]);
                }));
        })
        .then (results => {
            // Write the results to a file in a format that GnuPlot can display.
            const write_output = text => promisify (fs.writeFile) (argv.output, text);
            const write_stdout = text => process.stdout.write (text);

            // Flatten the two-dimensional results array to a string where there is one line for
            // each element of the outer dimension and an space-separated value for each element
            // for the inner. For example, [ [1,2,3], [4,5,6] ] becomes "1 2 3\n4 5 6\n".
            results = results.reduce ((acc, inner) => acc + inner.join (' ') + '\n', '');

            // Send the results to the chosen output file/stdout.
            return (argv.output == '-' ? write_stdout : write_output) ('external linkonce time\n' + results);
        })
        .catch (err => {
            if (argv.debug) {
                console.trace (err.stack);
            } else {
                console.error (err);
            }
            process.exitCode = 1;
        });
}

main ();

