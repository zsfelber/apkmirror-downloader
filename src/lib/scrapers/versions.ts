import { load } from "cheerio";

import { isNotNull } from "../../utils/typescript";
import { withBaseUrl } from "../utils";

export function getVersions(repoPageUrl: string, listViewHeaderText?: string) {
  let extrVersWthUploads = (versionsPageHtml: string)=>{
    return extractVersions(versionsPageHtml, listViewHeaderText);
  }
  return fetch(repoPageUrl)
    .then(res => res.text())
    .then(extrVersWthUploads);
}

export function extractVersions(versionsPageHtml: string, listViewHeaderText?: string) {
  const $ = load(versionsPageHtml);

  if (versionsPageHtml.includes("Enable JavaScript and cookies to continue")) {
    throw new Error(
      "This page cannot be loaded without JavaScript and cookies enabled :(",
    );
  }

  let table: cheerio.Cheerio|null = $('.listWidget:has(a[name="all_versions"])').first();
  if (!table.length && listViewHeaderText) {
    // <h5 class="widgetHeader">Latest Google Chrome Uploads</h5>
    //const h5 = $(`h5[class='widgetHeader'][text()='${listViewHeaderText}']`).first();
    let h5s = $(`h5[class='widgetHeader']`);
    let h5 = h5s.first();
    if (h5.text()==listViewHeaderText) {
      console.log("h5 text matches:", listViewHeaderText);
    } else {
      console.log("h5 text doesn't match:", h5.text()," expected:", listViewHeaderText);
    }

    console.log("h5:", h5);
    table = h5.length ? h5.parent().first() : null;
  }
  if (!table) {
    throw new Error("Could not find versions table");
  }

  const rows = table.children().toArray().slice(2, -1);
  // const moreUrl = table.children().last().find("a").first().attr("href");

  const versions = rows.map(row => {
    const $row = $(row);

    const name = $row.find(".table-cell").eq(1).find("a").first().text().trim();

    const url = $row.find(".table-cell").eq(1).find("a").first().attr("href");

    if (!name || !url) {
      return null;
    }

    return {
      name,
      url: withBaseUrl(url),
    };
  });

  return versions.filter(isNotNull);
}

export type Version = ReturnType<typeof extractVersions>[number];
