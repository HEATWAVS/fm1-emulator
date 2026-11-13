// node ci/engine/gen-tables.mjs <out.rs>   writes spichip_tables.rs (see tables.mjs). build.mjs does this for you.
import { writeFileSync } from "node:fs";
import { renderTables } from "./tables.mjs";
if (!process.argv[2]) { console.error("usage: node ci/engine/gen-tables.mjs <out.rs>"); process.exit(2); }
writeFileSync(process.argv[2], renderTables());
console.log(`wrote ${process.argv[2]}`);
