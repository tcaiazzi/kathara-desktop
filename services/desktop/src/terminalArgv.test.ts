import { describe, expect, it } from "vitest";
import { linuxTerminalArgv } from "./terminalArgv";

const only = (...installed: string[]) => (binary: string) => installed.includes(binary);

describe("linuxTerminalArgv", () => {
  it("prefers the distribution's default terminal", () => {
    expect(linuxTerminalArgv("/labs/demo", undefined, () => true)).toEqual(["x-terminal-emulator"]);
    expect(linuxTerminalArgv("/labs/demo", "kathara lstart", () => true)).toEqual([
      "x-terminal-emulator", "-e", "sh", "-c", "kathara lstart",
    ]);
  });

  it("falls back through the known emulators in order", () => {
    const looked: string[] = [];
    linuxTerminalArgv("/labs/demo", undefined, (binary) => {
      looked.push(binary);
      return false;
    });

    expect(looked).toEqual([
      "x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "alacritty", "kitty", "xterm",
    ]);
  });

  it.each([
    ["gnome-terminal", ["gnome-terminal", "--working-directory=/labs/my lab", "--", "sh", "-c", "ls"]],
    ["konsole", ["konsole", "--workdir", "/labs/my lab", "-e", "sh", "-c", "ls"]],
    ["xfce4-terminal", ["xfce4-terminal", "--working-directory=/labs/my lab", "-x", "sh", "-c", "ls"]],
    ["alacritty", ["alacritty", "--working-directory", "/labs/my lab", "-e", "sh", "-c", "ls"]],
    ["kitty", ["kitty", "-d", "/labs/my lab", "sh", "-c", "ls"]],
    ["xterm", ["xterm", "-e", "sh", "-c", "ls"]],
  ])("passes the directory and the command the way %s expects", (emulator, argv) => {
    expect(linuxTerminalArgv("/labs/my lab", "ls", only(emulator))).toEqual(argv);
  });

  it("opens a plain shell, with no command arguments, when there is no command", () => {
    expect(linuxTerminalArgv("/labs/demo", undefined, only("gnome-terminal"))).toEqual([
      "gnome-terminal", "--working-directory=/labs/demo",
    ]);
    expect(linuxTerminalArgv("/labs/demo", undefined, only("xterm"))).toEqual(["xterm"]);
  });

  it("is null when no known emulator is installed", () => {
    expect(linuxTerminalArgv("/labs/demo", "ls", () => false)).toBeNull();
  });
});
