import { Command } from "commander";
import { COMMANDS } from "./cli/commands/index.js";
import { VERSION } from "./version.js";

const program = new Command();
program.name("ptys");
program.version(VERSION, "-V, --version");
program.enablePositionalOptions();
for (const command of COMMANDS) command.register(program);
program.parse(process.argv);
