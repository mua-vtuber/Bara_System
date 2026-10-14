import { expect, test } from "bun:test";
import nativeHost from "./native-host.json";
import { downloadHeaders, PRODUCT_RELEASE_SOURCE, SELF_UPDATE, selfUpdateHeaders } from "./self-update.ts";
import { PET_VERSION } from "./version.ts";

test("the check runs every three hours against the public repository's latest release only", () => {
  expect(SELF_UPDATE.checkIntervalMs).toBe(3 * 60 * 60 * 1000);
  expect(PRODUCT_RELEASE_SOURCE.latestUrl).toBe("https://api.github.com/repos/mua-vtuber/Bara_System/releases/latest");
  expect(PRODUCT_RELEASE_SOURCE.downloadBaseUrl).toBe("https://github.com/mua-vtuber/Bara_System/releases/download/");
});

test("the installer name rule and the download folder are the host contract's values", () => {
  expect(SELF_UPDATE.installerSuffix).toBe(nativeHost.contract.installerSuffix);
  expect(SELF_UPDATE.installerSuffix).toBe("_x64-setup.exe");
  expect(SELF_UPDATE.updatesDirName).toBe(nativeHost.contract.updatesDirName);
  expect(SELF_UPDATE.updatesDirName).toBe("updates");
  expect(SELF_UPDATE.recordFileName).toBe("self-update.json");
});

test("a check sends only Accept and a User-Agent naming this pet's version, a download only the User-Agent", () => {
  expect(selfUpdateHeaders()).toEqual({ Accept: "application/vnd.github+json", "User-Agent": `BaraPet/${PET_VERSION}` });
  expect(downloadHeaders()).toEqual({ "User-Agent": `BaraPet/${PET_VERSION}` });
});
