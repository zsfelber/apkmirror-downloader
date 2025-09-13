import { existsSync, readFileSync, writeFileSync } from "fs";

import { match } from "ts-pattern";

import { cleanObject } from "../utils/object";
import { ensureExtension } from "../utils/path";
import type { LooseAutocomplete } from "../utils/types";
import { getFinalDownloadUrl } from "./scrapers/downloads";
import { getVariants, RedirectError } from "./scrapers/variants";
import { getVersions } from "./scrapers/versions";
import type { App, AppArch, AppOptions, Result, SpecialAppVersionToken, Variant, Version } from "./types";
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
import { execSync } from "child_process";

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
  retryDownloadFailures: true,
} satisfies AppOptions;

export type APKMDOptionsWithSuggestions = APKMDOptions & {
  arch?: LooseAutocomplete<AppArch>;
};

export type AppOptionsWithSuggestions = AppOptions & {
  arch?: LooseAutocomplete<AppArch>;
  version?: LooseAutocomplete<SpecialAppVersionToken>;
};

function delayAsync(millis:number, val?) {
    return new Promise<void>(resolve => {
        //console.log("WAIT:", millis);
        setTimeout(()=>{
            console.log("WAIT:", millis, " FINISHED");
            resolve(val);
        }, millis);
    });
}

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

  static downloadFailures: Record<string,boolean>;

  static loadDownloadFailures() {
      try {
        this.downloadFailures = JSON.parse(readFileSync(`${__dirname}/download-failures.json`).toString());
      } catch (e) {
        console.log("download-failures.json  load error:"+e.message);
        this.downloadFailures = {};
      }
  }

  static addDownloadFailure(url: string) {
    this.downloadFailures[url] = true;
    try {
      writeFileSync(`${__dirname}/download-failures.json`, JSON.stringify(this.downloadFailures));
    } catch (e) {
      console.log("download-failures.json  save error:"+e.message);
    }
  }

  static removeDownloadFailure(url: string) {
    delete this.downloadFailures[url];
    try {
      writeFileSync(`${__dirname}/download-failures.json`, JSON.stringify(this.downloadFailures));
    } catch (e) {
      console.log("download-failures.json  save error:"+e.message);
    }
  }

  static async download(app: App, options: AppOptionsWithSuggestions = {}) {
    const o = { ...DEFAULT_APP_OPTIONS, ...cleanObject(options) };

    this.loadDownloadFailures();

    if ((typeof o.version!="string") || isSpecialAppVersionToken(o.version)) {
      const repoUrl = makeRepoUrl(app);
      console.log("repoUrl:", repoUrl);

      let versions: Version[] = [];
      for (let i=0; i<10; ++i) {
        try {
          versions = await getVersions(repoUrl, app.listViewHeaderText);
          break;
        } catch (e:any) {
          if (e.message=="robot detected") {
            console.log(e.message+" try again (after 30 sec)..");
            await delayAsync(30000);
          } else {
            throw e;
          }
        }
      }


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

    if (o.retryDownloadFailures) {
      let fs = Object.keys(this.downloadFailures);
      if (fs.length) {
        console.log("\n\nretryDownloadFailures : "+fs.length+" items...\n");
        for (let vurl of fs) {
          await this.downloadVariantUrl(options, vurl);
        }
      } else {
        console.log("\nretryDownloadFailures : no download failure items...\n");
      }
    }

  }

  static async downloadAllVariants(app: App, options: AppOptionsWithSuggestions, variantsUrl: string) {
    const o = { ...DEFAULT_APP_OPTIONS, ...cleanObject(options) };

    if (!variantsUrl) {
      throw new Error("Could not find any suitable version");
    }

    let result: Result;

    let variants: Variant[] = [];
    for (let i=0; i<10; ++i) {
      try {
        variants = await getVariants(variantsUrl);
        result =  { redirected: false, variants };
        break;
      } catch (e:any) {
        if (e.message=="robot detected") {
          console.log(e.message+" try again (after 10 sec)..");
          await delayAsync(10000);
        } else if (e instanceof RedirectError) {
          result = {
            redirected: true,
            url: e.message
          };
        } else {
          throw e;
        }
      }
    }

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

      // filter by type
      variants = variants.filter(v => v.type === o.type);
      console.log(`variants(type:${o.type}):`, variants.length);

    }

    if (!variants.length) {
      console.warn(`WARN Could not find any suitable variant`);
    }

    for (let variant of variants) {
      await this.downloadVariant(options, variant);
    }
  }

  static async downloadVariant(options: AppOptionsWithSuggestions, selectedVariant: Variant) {
      console.log("Variant:", JSON.stringify(selectedVariant,null,2));
      return this.downloadVariantUrl(options, selectedVariant.url);
  }

  static async downloadVariantUrl(options: AppOptionsWithSuggestions, selectedVariantUrl: string) {

    const o = { ...DEFAULT_APP_OPTIONS, ...cleanObject(options) };

    try {
      const finalDownloadUrl = await getFinalDownloadUrl(selectedVariantUrl);

      console.log(`Downloading variant ${selectedVariantUrl} -> finalDownloadUrl:${finalDownloadUrl}...`);

      return fetch(finalDownloadUrl).then(async res => {
        const filename = extractFileNameFromUrl(res.url);
        const extension = filename.split(".").pop()!;

        const outDir = o.outDir ?? ".";
        const outFile = ensureExtension(o.outFile ?? filename, extension);
        const dest = `${outDir}/${outFile}`;

        if (outFile=="download.php") {
          console.log("WARN Got 'download.php', saved to tmp download failures.");
          this.addDownloadFailure(selectedVariantUrl);
          console.log("waiting 10 sec..");
          await delayAsync(10000);
          return { dest, skipped: true };
        }

        if (!o.overwrite && existsSync(dest)) {

          console.log(`(!overwrite+exists:skipped)\n`);

          return { dest, skipped: true };
        }

        await Bun.write(dest, res);

        console.log("Downloaded. Waiting 20 sec to avoid robot detection..");
        await delayAsync(20000);

        console.log(`\n`);

        return { dest, skipped: false };
      });
    } catch (e) {
      if (e instanceof RedirectError) {
        console.log("WARN "+e.message+", saved to tmp download failures.");
        this.addDownloadFailure(selectedVariantUrl);
        console.log("waiting 10 sec..");
        await delayAsync(10000);
        return { dest:null, skipped: true };
      } else {
        throw e;
      }
    }

  }
}
