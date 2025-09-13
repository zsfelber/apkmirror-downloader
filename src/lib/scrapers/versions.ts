import { load } from "cheerio";

import { isNotNull } from "../../utils/typescript";
import { withBaseUrl } from "../utils";
import type { Version } from "../types";

export function getVersions(repoPageUrl: string, listViewHeaderText?: string) {
  let extrVersWthUploads = (versionsPageHtml: string)=>{
    return extractVersions(versionsPageHtml, listViewHeaderText);
  }
  return fetch(repoPageUrl)
    .then(res => res.text())
    .then(extrVersWthUploads);
}

export function extractVersions(versionsPageHtml: string, listViewHeaderText?: string): Version[] {
  const $ = load(versionsPageHtml);

  if (versionsPageHtml.includes("Enable JavaScript and cookies to continue")) {
    throw new Error(
      "robot detected",
    );
  }

  let findXpath=(xpath:string): cheerio.Cheerio=>{
    let elem = $(xpath);
    if (elem.length) {
      console.log(`Found '${xpath}'  length:${elem.length}`);
      elem = elem.first();
    } else {
      console.log(`'${xpath}' Not Found`);
      elem = null;
    }
    return elem;
  }

  let table: cheerio.Cheerio = findXpath('.listWidget:has(a[name="all_versions"])');

  if (!table && listViewHeaderText) {

    let h5 = findXpath(`h5[class='widgetHeader']`);
    if (h5) {
      // <h5 class="widgetHeader">Latest Google Chrome Uploads</h5>
      let tx = h5.text().trim();
      if (tx==listViewHeaderText) {
        console.log("h5 text matches:", listViewHeaderText);

        //console.log("h5:", h5);
        table = h5.parent();
      } else {
        console.log(`whd text doesn't match:'${tx}' expected:'${listViewHeaderText}'`);
      }
    }
    
    if (!table) {

      //not working
      //let whd = findXpath(`div[class='widgetHeader'][class='search-header']`);
      let whd = findXpath(`div[class='widgetHeader search-header']`);
      if (whd) {
        //<div class="widgetHeader search-header">
        //    Results for <span style="word-break:break-all">“chrome”</span> <a href="#searchtips" data-toggle="modal">(search tips)</a>
        //</div>
        //text: 'Results for “chrome” (search tips)'

        let tx = whd.text().trim();
        if (tx==listViewHeaderText) {
          console.log("whd text matches:", listViewHeaderText);
          table = whd.nextAll();
        } else {
          console.log(`whd text doesn't match:'${tx}' expected:'${listViewHeaderText}'`);
        }

      }
    }
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

//export type Version = ReturnType<typeof extractVersions>[number];
