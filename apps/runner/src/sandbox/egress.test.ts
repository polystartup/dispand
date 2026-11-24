import { expect, test } from "vitest";
import { blockList, refused } from "./egress.ts";

test("metadata, loopback and link-local are refused in every address form, a public address isn't", () => {
  const list = blockList(["198.51.100.7"]);
  for (const address of [
    "169.254.169.254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:a9fe:a9fe",
    "168.63.129.16", "100.100.100.200", "fd00:ec2::254", "fd20:ce::254", "127.0.0.1", "::1", "0.0.0.0", "fe80::1",
    "198.51.100.7",
  ]) expect(refused(list, address), address).toBe(true);
  for (const address of ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]) expect(refused(list, address), address).toBe(false);
});
