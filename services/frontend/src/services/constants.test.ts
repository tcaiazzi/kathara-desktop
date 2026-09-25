import { describe, expect, it } from "vitest";
import { machine } from "../test/fixtures";
import { HOST_BRIDGE, visibleInterfaces, visibleLinks } from "./constants";

describe("the internal host bridge stays out of sight", () => {
  it("visibleInterfaces drops only the interface on Kathara's host bridge", () => {
    const m = machine({
      interfaces: [
        { num: 0, link: "A", mac_address: null },
        { num: 1, link: HOST_BRIDGE, mac_address: "02:42:ac:11:00:02" },
        { num: 2, link: "B", mac_address: null },
      ],
    });

    expect(visibleInterfaces(m).map((i) => i.link)).toEqual(["A", "B"]);
  });

  it("visibleLinks drops only Kathara's host bridge, keeping every other field", () => {
    const links = [
      { name: "A", machines: ["pc1"] },
      { name: HOST_BRIDGE, machines: ["pc1", "pc2"] },
      { name: "kathara_host_bridge_2", machines: [] },
    ];

    expect(visibleLinks(links)).toEqual([links[0], links[2]]);
  });
});
