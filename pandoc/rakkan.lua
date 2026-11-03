-- Rakkan filter for Pandoc.
--
-- Input: a note converted with the plugin's "导出为新笔记：Pandoc 格式"
-- command, where AI text is [text]{.rk-ai ...}, the author's own words inside
-- an AI block are [text]{.rk-human}, and quotes are [text]{.rk-quote ...}.
--
--   pandoc note.md --lua-filter=rakkan.lua -o note.pdf
--
-- Set `rakkan:` in the note's metadata, or pass -M rakkan=plain:
--   color  (default)  colour AI text and quotes by model family (HTML, LaTeX/PDF);
--                     other formats get a paragraph/character style named "Rakkan AI" / "Rakkan Quote"
--   plain             drop all of it and keep just the text
--   keep              leave the spans and divs as they are

local mode = "color"

local colors = {
  claude = "d97757", gpt = "10a37f", gemini = "4e7ff0", deepseek = "4d6bfe",
  grok = "6b7280", llama = "0866ff", muse = "d6338a", qwen = "615ced",
  mistral = "fa520f", kimi = "0ea5e9", glm = "14b8a6", generic = "8b5cf6",
  quote = "b08d57",
}

local function has(el, class)
  for _, c in ipairs(el.classes) do
    if c == class then return true end
  end
  return false
end

local function colorOf(el)
  if has(el, "rk-quote") then return colors.quote end
  if has(el, "rk-ai") then return colors[el.attributes.family or ""] or colors.generic end
  return nil
end

local function styleName(el)
  if has(el, "rk-quote") then return "Rakkan Quote" end
  if has(el, "rk-ai") then return "Rakkan AI" end
  return "Rakkan Human"
end

local function ours(el)
  return has(el, "rk-ai") or has(el, "rk-human") or has(el, "rk-quote")
end

local function Meta(meta)
  if meta.rakkan then mode = pandoc.utils.stringify(meta.rakkan) end
end

local function Span(el)
  if not ours(el) or mode == "keep" then return nil end
  if mode == "plain" then return el.content end
  local color = colorOf(el)
  if FORMAT:match("html") then
    -- The author's own words inside AI text go back to the normal colour.
    el.attributes.style = color and ("color: #" .. color) or "color: initial"
    return el
  elseif FORMAT:match("latex") then
    if not color then
      local plain = { pandoc.RawInline("latex", "{\\normalcolor ") }
      for _, x in ipairs(el.content) do plain[#plain + 1] = x end
      plain[#plain + 1] = pandoc.RawInline("latex", "}")
      return plain
    end
    local out = { pandoc.RawInline("latex", "\\textcolor[HTML]{" .. color:upper() .. "}{") }
    for _, x in ipairs(el.content) do out[#out + 1] = x end
    out[#out + 1] = pandoc.RawInline("latex", "}")
    return out
  else
    el.attributes["custom-style"] = styleName(el)
    return el
  end
end

local function Div(el)
  if not ours(el) or mode == "keep" then return nil end
  if mode == "plain" then return el.content end
  local color = colorOf(el)
  if FORMAT:match("html") then
    if color then el.attributes.style = "color: #" .. color end
    return el
  elseif FORMAT:match("latex") then
    if not color then return el.content end
    local out = { pandoc.RawBlock("latex", "\\begingroup\\color[HTML]{" .. color:upper() .. "}") }
    for _, x in ipairs(el.content) do out[#out + 1] = x end
    out[#out + 1] = pandoc.RawBlock("latex", "\\endgroup")
    return out
  else
    el.attributes["custom-style"] = styleName(el)
    return el
  end
end

return { { Meta = Meta }, { Span = Span, Div = Div } }
