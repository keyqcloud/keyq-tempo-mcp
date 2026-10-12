// tsup bundles .md files as text (see tsup.config.ts).
declare module '*.md' {
  const text: string;
  export default text;
}
