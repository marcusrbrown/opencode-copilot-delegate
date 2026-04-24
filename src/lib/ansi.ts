// biome-ignore lint/complexity/useRegexLiterals: constructor avoids control-character regex literal lint
const ANSI_ESCAPE_PATTERN = new RegExp(
  '(?:\\u001B|\\u009B)[[\\]()#;?]*(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]|(?:[\\dA-PR-TZcf-nq-uy=><~]))',
  'g',
)

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '')
}
