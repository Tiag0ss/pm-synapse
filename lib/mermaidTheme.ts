/**
 * Shared Mermaid theme + ELK config for browser preview and DOCX export.
 * Keep in sync with app/globals.css Synapse palette.
 */

export const MERMAID_SYNAPSE = {
  bg: '#0a0e13',
  panel: '#111820',
  surface: '#0e141c',
  surface2: '#1a2430',
  border: '#243041',
  borderStrong: '#334155',
  text: '#e8eef6',
  muted: '#8b98a8',
  accent: '#14b8a6',
  accentSoft: '#5eead4',
/** Prefer DM Sans in the browser; DOCX export uses DejaVu (see server mermaidDocxRender). */
  fontSans: '"DM Sans", ui-sans-serif, system-ui, sans-serif',
} as const;

export type MermaidSynapseInitOptions = {
  /** Browser preview often true; DOCX raster prefers false for stable pixel size. */
  useMaxWidth?: boolean;
  /** Opaque background for PNG export; transparent in the dark UI. */
  background?: string;
};

export function mermaidSynapseInit(options: MermaidSynapseInitOptions = {}) {
  const useMaxWidth = options.useMaxWidth ?? true;
  const background = options.background ?? 'transparent';
  return {
    startOnLoad: false as const,
    securityLevel: 'loose' as const,
    logLevel: 'fatal' as const,
    theme: 'base' as const,
    darkMode: true,
    fontFamily: MERMAID_SYNAPSE.fontSans,
    htmlLabels: true,
    layout: 'elk' as const,
    elk: {
      mergeEdges: false,
      nodePlacementStrategy: 'BRANDES_KOEPF' as const,
    },
    flowchart: {
      htmlLabels: true,
      curve: 'linear' as const,
      padding: 12,
      nodeSpacing: 50,
      rankSpacing: 55,
      diagramPadding: 10,
      wrappingWidth: 220,
      useMaxWidth,
    },
    sequence: {
      useMaxWidth,
      actorMargin: 50,
      messageMargin: 40,
    },
    themeVariables: {
      darkMode: true,
      background,
      fontFamily: MERMAID_SYNAPSE.fontSans,
      primaryColor: MERMAID_SYNAPSE.surface2,
      primaryTextColor: MERMAID_SYNAPSE.text,
      primaryBorderColor: MERMAID_SYNAPSE.accent,
      secondaryColor: MERMAID_SYNAPSE.panel,
      secondaryTextColor: MERMAID_SYNAPSE.text,
      secondaryBorderColor: MERMAID_SYNAPSE.borderStrong,
      tertiaryColor: MERMAID_SYNAPSE.surface,
      tertiaryTextColor: MERMAID_SYNAPSE.text,
      tertiaryBorderColor: MERMAID_SYNAPSE.border,
      mainBkg: MERMAID_SYNAPSE.surface2,
      nodeBorder: MERMAID_SYNAPSE.accent,
      clusterBkg: MERMAID_SYNAPSE.panel,
      clusterBorder: MERMAID_SYNAPSE.borderStrong,
      lineColor: MERMAID_SYNAPSE.accentSoft,
      textColor: MERMAID_SYNAPSE.text,
      titleColor: MERMAID_SYNAPSE.text,
      edgeLabelBackground: MERMAID_SYNAPSE.panel,
      noteBkgColor: MERMAID_SYNAPSE.panel,
      noteTextColor: MERMAID_SYNAPSE.text,
      noteBorderColor: MERMAID_SYNAPSE.borderStrong,
      actorBkg: MERMAID_SYNAPSE.surface2,
      actorBorder: MERMAID_SYNAPSE.accent,
      actorTextColor: MERMAID_SYNAPSE.text,
      signalColor: MERMAID_SYNAPSE.accentSoft,
      signalTextColor: MERMAID_SYNAPSE.text,
      labelBoxBkgColor: MERMAID_SYNAPSE.panel,
      labelBoxBorderColor: MERMAID_SYNAPSE.border,
      labelTextColor: MERMAID_SYNAPSE.muted,
      fontSize: '14px',
    },
  };
}

/** Ensure the diagram text asks for ELK (matches browser preview). */
export function withElkConfig(source: string): string {
  const trimmed = source.trim();
  if (/layout\s*:\s*elk\b/i.test(trimmed)) return trimmed;
  if (/^\s*---/.test(trimmed)) {
    return trimmed.replace(/^---\s*\n/, '---\nconfig:\n  layout: elk\n');
  }
  return `---\nconfig:\n  layout: elk\n---\n${trimmed}`;
}
