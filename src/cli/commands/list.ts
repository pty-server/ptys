import type { Session, Workspace } from "@pty-server/protocol";
import { ClientCommand, type ClientOptions } from "../client-command.js";
import { JSON_OPTION, type CommandContext, type OptionSpec } from "../command.js";

export interface ListCommandOptions extends ClientOptions {
  json?: boolean;
}

function status(session: Session): string {
  if (!session.exited) {
    return "running";
  }
  return `exited ${session.exited.code}${session.exited.signal ? ` (${session.exited.signal})` : ""}`;
}

function stripControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
}

function printTable(sessions: Session[], workspaces: Workspace[]): void {
  const directories = new Map(workspaces.map((workspace) => [workspace.id, workspace.realpath]));
  const rows = sessions.map((session) =>
    [
      session.id.slice(0, 8),
      session.name ?? "",
      [session.cmd, ...session.args].join(" "),
      directories.get(session.workspaceId) ?? "(unavailable)",
      status(session),
    ].map(stripControlCharacters),
  );
  const headers = ["ID", "NAME", "COMMAND", "DIRECTORY", "STATUS"];
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index].length)));
  const format = (row: string[]) => row.map((value, index) => value.padEnd(widths[index])).join("  ");

  console.log(format(headers));
  for (const row of rows) {
    console.log(format(row));
  }
}

export class ListCommand extends ClientCommand<[], ListCommandOptions> {
  readonly name = "list";
  readonly description = "list sessions";
  readonly extraOptions: OptionSpec[] = [JSON_OPTION];

  async run(ctx: CommandContext<[], ListCommandOptions>): Promise<void> {
    const options = ctx.options;
    const client = this.client(options);
    const sessions = await client.listSessions();

    if (options.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }

    printTable(sessions, await client.listWorkspaces());
  }
}
