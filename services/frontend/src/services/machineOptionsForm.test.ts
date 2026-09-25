import { describe, expect, it } from "vitest";
import { machine } from "../test/fixtures";
import {
  defaultOptionsFormState,
  optionsFormStateFromMachine,
  optionsFormStateToPayload,
  type OptionsFormState,
} from "./machineOptionsForm";

const configured = machine({
  image: "kathara/frr",
  mem: "256m",
  cpus: 0.5,
  shell: "/bin/bash",
  num_terms: 2,
  entrypoint: "/sbin/init",
  args: "--verbose",
  privileged: true,
  bridged: true,
  ipv6: false,
  envs: { MODE: "lab", LEVEL: "3" },
  sysctls: { "net.ipv4.ip_forward": 1 },
  ulimits: [{ name: "nofile", soft: 1024, hard: 4096 }],
  exec_commands: ["ip a", "echo ready"],
  ports: [{ host_port: 8080, guest_port: 80, protocol: "tcp" }],
  volumes: [{ host_path: "/srv/data", guest_path: "/data", mode: "rw" }],
  metas: { custom: "x" },
});

describe("optionsFormStateFromMachine", () => {
  it("turns dict options into rows and numbers into strings", () => {
    const form = optionsFormStateFromMachine(configured);

    expect(form).toMatchObject({
      image: "kathara/frr",
      cpus: "0.5",
      numTerms: "2",
      ipv6: false,
      envs: [
        { key: "MODE", value: "lab" },
        { key: "LEVEL", value: "3" },
      ],
      sysctls: [{ key: "net.ipv4.ip_forward", value: "1" }],
      execCommands: [{ value: "ip a" }, { value: "echo ready" }],
      metas: [{ key: "custom", value: "x" }],
    });
  });

  it("shows unset options as empty fields", () => {
    const form = optionsFormStateFromMachine(machine());

    expect(form).toMatchObject({ image: "", mem: "", cpus: "", numTerms: "", ipv6: null, envs: [] });
  });

  it("copies list items, so editing the form never mutates the device it came from", () => {
    const form = optionsFormStateFromMachine(configured);
    form.ports[0].host_port = 9999;
    form.volumes[0].mode = "ro";
    form.ulimits[0].soft = 1;

    expect(configured.ports[0].host_port).toBe(8080);
    expect(configured.volumes[0].mode).toBe("rw");
    expect(configured.ulimits[0].soft).toBe(1024);
  });
});

describe("optionsFormStateToPayload", () => {
  it("round-trips a device's options unchanged", () => {
    const payload = optionsFormStateToPayload(optionsFormStateFromMachine(configured));

    expect(payload).toEqual({
      image: "kathara/frr",
      mem: "256m",
      cpus: 0.5,
      shell: "/bin/bash",
      num_terms: 2,
      entrypoint: "/sbin/init",
      args: "--verbose",
      privileged: true,
      bridged: true,
      ipv6: false,
      envs: { MODE: "lab", LEVEL: "3" },
      sysctls: { "net.ipv4.ip_forward": "1" },
      ulimits: [{ name: "nofile", soft: 1024, hard: 4096 }],
      exec_commands: ["ip a", "echo ready"],
      ports: [{ host_port: 8080, guest_port: 80, protocol: "tcp" }],
      volumes: [{ host_path: "/srv/data", guest_path: "/data", mode: "rw" }],
      metas: { custom: "x" },
    });
  });

  it("trims text fields and sends a blank one as null", () => {
    const form: OptionsFormState = {
      ...defaultOptionsFormState(),
      image: "  kathara/base  ",
      mem: "   ",
      cpus: " ",
      numTerms: "",
      shell: "\t",
    };

    expect(optionsFormStateToPayload(form)).toMatchObject({
      image: "kathara/base",
      mem: null,
      cpus: null,
      num_terms: null,
      shell: null,
      entrypoint: null,
      args: null,
    });
  });

  it("drops rows the user left incomplete", () => {
    const form: OptionsFormState = {
      ...defaultOptionsFormState(),
      envs: [
        { key: " MODE ", value: " lab " },
        { key: "   ", value: "orphan value" },
      ],
      sysctls: [{ key: "", value: "1" }],
      ulimits: [
        { name: "nofile", soft: 1, hard: 2 },
        { name: "  ", soft: 3, hard: 4 },
      ],
      execCommands: [{ value: "ip a" }, { value: "   " }],
      volumes: [
        { host_path: "/srv", guest_path: "/data", mode: "rw" },
        { host_path: "/only-host", guest_path: " ", mode: "rw" },
        { host_path: "", guest_path: "/only-guest", mode: "ro" },
      ],
    };

    const payload = optionsFormStateToPayload(form);
    // Exact, not toMatchObject: a partial match would let an extra row (say, one with a blank
    // key) through unnoticed. The key is trimmed; the value is sent exactly as typed.
    expect(payload.envs).toEqual({ MODE: " lab " });
    expect(payload.sysctls).toEqual({});
    expect(payload.ulimits).toEqual([{ name: "nofile", soft: 1, hard: 2 }]);
    expect(payload.exec_commands).toEqual(["ip a"]);
    expect(payload.volumes).toEqual([{ host_path: "/srv", guest_path: "/data", mode: "rw" }]);
  });

  it("starts a new device from Kathara's base image with every other option unset", () => {
    expect(optionsFormStateToPayload(defaultOptionsFormState())).toEqual({
      image: "kathara/base",
      mem: null,
      cpus: null,
      shell: null,
      num_terms: null,
      entrypoint: null,
      args: null,
      privileged: false,
      bridged: false,
      ipv6: null,
      envs: {},
      sysctls: {},
      ulimits: [],
      exec_commands: [],
      ports: [],
      volumes: [],
      metas: {},
    });
  });
});

describe("blank and whitespace-only fields", () => {
  it("turns every whitespace-only text field into null, numbers included", () => {
    const form: OptionsFormState = {
      ...defaultOptionsFormState(),
      shell: "  ", entrypoint: "\t", args: " ", numTerms: "  ", cpus: " ",
      metas: [{ key: "  ", value: "x" }, { key: " custom ", value: "v" }],
      volumes: [{ host_path: "  ", guest_path: "/data", mode: "rw" }],
    };

    const payload = optionsFormStateToPayload(form);

    expect([payload.shell, payload.entrypoint, payload.args, payload.num_terms, payload.cpus]).toEqual([null, null, null, null, null]);
    expect(payload.metas).toEqual({ custom: "v" });
    expect(payload.volumes).toEqual([]);
  });

  it("shows a device's unset text options as empty strings, not \"null\"", () => {
    const form = optionsFormStateFromMachine(machine());

    expect([form.shell, form.entrypoint, form.args]).toEqual(["", "", ""]);
  });
});
