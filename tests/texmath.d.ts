// markdown-it-texmath has no types of its own; P6 uses it only as a markdown-it plugin.
declare module "markdown-it-texmath" {
  import type MarkdownIt from "markdown-it";
  const texmath: MarkdownIt.PluginWithOptions<{
    engine: { renderToString(tex: string, options: { displayMode?: boolean }): string };
    delimiters?: string | string[];
  }>;
  export default texmath;
}
