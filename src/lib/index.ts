import { existsSync } from "fs";

import { match } from "ts-pattern";

import { cleanObject } from "../utils/object";
import { ensureExtension } from "../utils/path";
import type { LooseAutocomplete } from "../utils/types";
import { getFinalDownloadUrl } from "./scrapers/downloads";
import { getVariants, RedirectError } from "./scrapers/variants";
import { getVersions } from "./scrapers/versions";
import type { App, AppArch, AppOptions, SpecialAppVersionToken, Variant, Version } from "./types";
import {
  extractFileNameFromUrl,
  isAlphaVersion,
  isBetaVersion,
  isSpecialAppVersionToken,
  isStableVersion,
  isUniversalVariant,
  makeRepoUrl,
  makeVariantsUrl,
} from "./utils";

export type APKMDOptions = {
  arch?: AppOptions["arch"];
  dpi?: AppOptions["dpi"];
  minAndroidVersion?: AppOptions["minAndroidVersion"];
  outDir?: AppOptions["outDir"];
};

const DEFAULT_APP_OPTIONS = {
  type: "apk",
  version: "stable",
  arch: "universal",
  dpi: "nodpi",
  overwrite: true,
} satisfies AppOptions;

export type APKMDOptionsWithSuggestions = APKMDOptions & {
  arch?: LooseAutocomplete<AppArch>;
};

export type AppOptionsWithSuggestions = AppOptions & {
  arch?: LooseAutocomplete<AppArch>;
  version?: LooseAutocomplete<SpecialAppVersionToken>;
};

export class APKMirrorDownloader {
  #options: APKMDOptions;

  constructor(options: APKMDOptionsWithSuggestions = {}) {
    this.#options = cleanObject(options);
  }

  download(app: App, options: AppOptionsWithSuggestions = {}) {
    const o = {
      ...DEFAULT_APP_OPTIONS,
      ...this.#options,
      ...cleanObject(options),
    };
    return APKMirrorDownloader.download(app, o);
  }

  static async download(app: App, options: AppOptionsWithSuggestions = {}) {
    const o = { ...DEFAULT_APP_OPTIONS, ...cleanObject(options) };

    if ((typeof o.version!="string") || isSpecialAppVersionToken(o.version)) {
      const repoUrl = makeRepoUrl(app);
      console.log("repoUrl:", repoUrl);
      const versions = await getVersions(repoUrl, app.listViewHeaderText);

      let isRgxVersion = (version: Version)=>{
        return version.name.match(o.version);
      };

      /*const selectedVersion = match(o.version)
        .with("latest", () => versions[0])
        .with("beta", () => versions.find(isBetaVersion))
        .with("alpha", () => versions.find(isAlphaVersion))
        .with("stable", () => versions.find(isStableVersion))
        .otherwise(() => versions.find(isRgxVersion));*/
      let matchedVersions: Version[] = [];
      switch (o.version) {
      case "latest": matchedVersions[0] = versions[0]; break;
      case "beta":   matchedVersions = versions.filter(isBetaVersion); break;
      case "alpha":  matchedVersions = versions.filter(isAlphaVersion); break;
      case "stable": matchedVersions = versions.filter(isStableVersion); break;
      default:       matchedVersions = versions.filter(isRgxVersion); break;
      }

      if (!matchedVersions.length) {
        console.warn(`WARN Could not find any suitable ${o.version} version`);
      }

      console.log("total versions:", versions.length," matching:", matchedVersions.length);

      for (let matchedVersion of matchedVersions) {
        console.log(`Downloading ${matchedVersion.name}...`);
        await this.downloadAllVariants(app, options, matchedVersion.url);
        console.log(`\n\n`);
      }
    } else {
      let variantsUrl = makeVariantsUrl(app, o.version);
      console.log(`Downloading ${app.repo} ${o.version}...`);
      await this.downloadAllVariants(app, options, variantsUrl);
    }
  }

  static async downloadAllVariants(app: App, options: AppOptionsWithSuggestions, variantsUrl: string) {
    const o = { ...DEFAULT_APP_OPTIONS, ...cleanObject(options) };

    if (!variantsUrl) {
      throw new Error("Could not find any suitable version");
    }

    const result = await getVariants(variantsUrl)
      .then(variants => ({ redirected: false as const, variants }))
      .catch(err => {
        if (err instanceof RedirectError) {
          return {
            redirected: true as const,
            url: err.message,
            variants: null,
          };
        }

        throw err;
      });

    let variants: Variant[];

    if (result.redirected) {
      console.warn(
        "[WARNING]",
        `Only single variant is supported for ${app.org}/${app.repo}`,
      );
      variants = [{
        url: result.url
      }];
    } else {
      variants = result.variants;
      console.log("variants:", variants.length);

      // filter by arch
      if (o.arch !== "universal" && o.arch !== "noarch") {

        let variants1 = variants.filter(v => v.arch?.match(new RegExp("\\b"+o.arch+"\\b")));

        variants = variants1.length
          ? variants1
          : variants.filter(isUniversalVariant); // fallback to universal
      } else {
        variants = variants.filter(isUniversalVariant);
      }
      console.log(`variants(arch:${o.arch}):`, variants.length);

      // filter by dpi
      if (o.dpi !== "*" && o.dpi !== "any") {
        variants = variants.filter(v => v.dpi === o.dpi);
      }
      console.log(`variants(dpi:${o.dpi}):`, variants.length);

      // filter by minAndroidVersion
      if (o.minAndroidVersion) {
        variants = variants.filter(
          v =>
            parseFloat(v.minAndroidVersion!) <= parseFloat(o.minAndroidVersion!),
        );
      }
      console.log(`variants(minAndroidVersion:${o.minAndroidVersion}):`, variants.length);

      console.log(`variants:`, variants);

      // filter by type
      variants = variants.filter(v => v.type === o.type);
      console.log(`variants(type:${o.type}):`, variants);

    }

    if (!variants.length) {
      console.warn(`WARN Could not find any suitable variant`);
    }

    for (let variant of variants) {
      this.downloadVariant(options, variant);
    }
  }

  static async downloadVariant(options: AppOptionsWithSuggestions, selectedVariant: Variant) {
    console.log(`Downloading variant ${JSON.stringify(selectedVariant)}...`);

    const o = { ...DEFAULT_APP_OPTIONS, ...cleanObject(options) };

    const finalDownloadUrl = await getFinalDownloadUrl(selectedVariant.url);

    return fetch(finalDownloadUrl).then(async res => {
      const filename = extractFileNameFromUrl(res.url);
      const extension = filename.split(".").pop()!;

      const outDir = o.outDir ?? ".";
      const outFile = ensureExtension(o.outFile ?? filename, extension);
      const dest = `${outDir}/${outFile}`;

      if (!o.overwrite && existsSync(dest)) {
        return { dest, skipped: true as const };
      }

      await Bun.write(dest, res);
      return { dest, skipped: false as const };
    });
  }
}
