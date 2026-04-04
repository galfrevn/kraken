export type ThemeColors = {
  primary: string;
  secondary: string;
  accent: string;
  error: string;
  warning: string;
  success: string;
  info: string;
  text: string;
  textMuted: string;
  background: string;
  backgroundPanel: string;
  backgroundElement: string;
  backgroundMenu: string;
  border: string;
  borderActive: string;
  borderSubtle: string;
  diffAdded: string;
  diffRemoved: string;
  diffContext: string;
  diffHunkHeader: string;
  diffHighlightAdded: string;
  diffHighlightRemoved: string;
  diffAddedBackground: string;
  diffRemovedBackground: string;
  diffContextBackground: string;
  diffLineNumber: string;
  diffAddedLineNumberBackground: string;
  diffRemovedLineNumberBackground: string;
  markdownText: string;
  markdownHeading: string;
  markdownLink: string;
  markdownLinkText: string;
  markdownCode: string;
  markdownBlockQuote: string;
  markdownEmph: string;
  markdownStrong: string;
  markdownHorizontalRule: string;
  markdownListItem: string;
  markdownListEnumeration: string;
  markdownImage: string;
  markdownImageText: string;
  markdownCodeBlock: string;
  syntaxComment: string;
  syntaxKeyword: string;
  syntaxFunction: string;
  syntaxVariable: string;
  syntaxString: string;
  syntaxNumber: string;
  syntaxType: string;
  syntaxOperator: string;
  syntaxPunctuation: string;
};

type HexColor = `#${string}`;

type DarkLightVariant = {
  dark: HexColor | string;
  light: HexColor | string;
};

export type ColorValue = HexColor | string | DarkLightVariant;

export type ThemeJson = {
  $schema?: string;
  defs?: Record<string, HexColor | string>;
  theme: Record<string, ColorValue>;
};
