// Copy the built plugin into demo-vault/.obsidian/plugins/rakkan and enable it.
// Usage: npm run demo   (then open demo-vault/ as a vault in Obsidian)
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const dir = "demo-vault/.obsidian/plugins/rakkan";
mkdirSync(dir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(f, `${dir}/${f}`);

const list = "demo-vault/.obsidian/community-plugins.json";
const enabled = existsSync(list) ? JSON.parse(readFileSync(list, "utf8")) : [];
if (!enabled.includes("rakkan")) writeFileSync(list, JSON.stringify([...enabled, "rakkan"], null, 2));
console.log(`Installed into ${dir}. Open demo-vault/ in Obsidian and trust the plugin.`);
