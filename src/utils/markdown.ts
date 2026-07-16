import * as SimpleMarkdown from 'simple-markdown';

const mdParse = SimpleMarkdown.defaultBlockParse;
const mdOutput = SimpleMarkdown.defaultReactOutput;

export const mdStringToReact = (markdown: string) =>
  mdOutput(mdParse(markdown));
