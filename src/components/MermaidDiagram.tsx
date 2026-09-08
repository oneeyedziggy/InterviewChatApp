'use client';

import { useEffect, useId, useRef, useState } from 'react';

type MermaidDiagramProps = {
  chart: string;
  title?: string;
};

const MermaidDiagram = ({ chart, title }: MermaidDiagramProps) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const reactId = useId();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // mermaid touches document/window at import time, so it must stay client-only.
    const render = async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          flowchart: { htmlLabels: true, curve: 'basis', useMaxWidth: true },
          themeVariables: {
            fontFamily: 'Arial, Helvetica, sans-serif',
            primaryColor: '#eef6ff',
            primaryTextColor: '#0c1b33',
            primaryBorderColor: '#004ca8',
            lineColor: '#006f84',
            secondaryColor: '#e6fbff',
            tertiaryColor: '#ffffff',
          },
        });

        const domId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`;
        const { svg } = await mermaid.render(domId, chart);
        if (cancelled || !hostRef.current) {
          return;
        }
        hostRef.current.innerHTML = svg;
        setError(null);
      } catch (renderError) {
        if (!cancelled) {
          setError(
            renderError instanceof Error
              ? renderError.message
              : 'Failed to render diagram',
          );
        }
      }
    };

    void render();

    return () => {
      cancelled = true;
    };
  }, [chart, reactId]);

  return (
    <div
      role="img"
      aria-label={title ? `${title} diagram` : 'Diagram'}
      data-testid="mermaid-diagram"
    >
      {error ? <pre>{error}</pre> : null}
      <div ref={hostRef} />
    </div>
  );
};

export default MermaidDiagram;
