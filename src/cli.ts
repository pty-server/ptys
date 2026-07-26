import { Command } from "commander";
import { COMMANDS } from "./cli/commands/index.js";

const program = new Command();
program.name("ptys");
program.enablePositionalOptions();
for (const command of COMMANDS) command.register(program);
program.parse(process.argv);
