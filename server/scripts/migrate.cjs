// Run `knex migrate:latest` without npm (the runtime image ships no npm).
// Resolves knex wherever the workspace install hoisted it.
process.argv = [process.argv[0], 'knex', 'migrate:latest', '--knexfile', 'knexfile.ts', ...process.argv.slice(2)];
require(require.resolve('knex/bin/cli.js'));
