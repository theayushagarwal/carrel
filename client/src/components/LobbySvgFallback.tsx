import React from 'react';

export function LobbySvgFallback() {
  return (
    <div className="lobby-scene-fallback" data-testid="lobby-fallback">
      <svg
        viewBox="0 0 540 560"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="lobby-fallback-svg"
        role="img"
        aria-label="Collaborative code sheets: Dijkstra, SQL, and Python"
      >
        <defs>
          <filter id="shadow-sheet-svg" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="8" stdDeviation="12" floodColor="rgba(0,0,0,0.4)" />
          </filter>
        </defs>

        {/* Fake contact shadow */}
        <ellipse cx="270" cy="510" rx="180" ry="24" fill="rgba(0,0,0,0.3)" />

        {/* Sheet 3: Python (bottom, rotated -5deg) */}
        <g transform="translate(190, 80) rotate(-6)">
          <rect
            width="280"
            height="380"
            rx="4"
            fill="var(--raised)"
            stroke="var(--border)"
            strokeWidth="1"
            filter="url(#shadow-sheet-svg)"
          />
          <text x="20" y="32" fill="var(--muted)" fontFamily="IBM Plex Mono" fontSize="10">
            stream.py
          </text>
          <line x1="20" y1="42" x2="260" y2="42" stroke="var(--border)" strokeWidth="1" />
          <text x="20" y="70" fill="var(--syntax-comment)" fontFamily="IBM Plex Mono" fontSize="11">
            # Event queue
          </text>
          <text x="20" y="94" fill="var(--syntax-keyword)" fontFamily="IBM Plex Mono" fontSize="11">
            async def <tspan fill="var(--text)">stream_presence</tspan>():
          </text>
          <text x="36" y="118" fill="var(--text)" fontFamily="IBM Plex Mono" fontSize="11">
            queue = asyncio.Queue()
          </text>
          <text
            x="36"
            y="142"
            fill="var(--syntax-keyword)"
            fontFamily="IBM Plex Mono"
            fontSize="11"
          >
            while <tspan fill="var(--syntax-number)">True</tspan>:
          </text>
          <text
            x="52"
            y="166"
            fill="var(--syntax-keyword)"
            fontFamily="IBM Plex Mono"
            fontSize="11"
          >
            yield <tspan fill="var(--text)">await queue.get()</tspan>
          </text>
        </g>

        {/* Sheet 2: SQL (middle, rotated 4deg) */}
        <g transform="translate(140, 60) rotate(4)">
          <rect
            width="290"
            height="390"
            rx="4"
            fill="var(--panel)"
            stroke="var(--border)"
            strokeWidth="1"
            filter="url(#shadow-sheet-svg)"
          />
          <text x="20" y="32" fill="var(--muted)" fontFamily="IBM Plex Mono" fontSize="10">
            metrics.sql
          </text>
          <line x1="20" y1="42" x2="270" y2="42" stroke="var(--border)" strokeWidth="1" />
          <text x="20" y="70" fill="var(--syntax-comment)" fontFamily="IBM Plex Mono" fontSize="11">
            -- Session metrics
          </text>
          <text x="20" y="94" fill="var(--syntax-keyword)" fontFamily="IBM Plex Mono" fontSize="11">
            WITH <tspan fill="var(--text)">sessions</tspan> AS (
          </text>
          <text
            x="36"
            y="118"
            fill="var(--syntax-keyword)"
            fontFamily="IBM Plex Mono"
            fontSize="11"
          >
            SELECT <tspan fill="var(--text)">user_id, count(*)</tspan>
          </text>
          <text
            x="36"
            y="142"
            fill="var(--syntax-keyword)"
            fontFamily="IBM Plex Mono"
            fontSize="11"
          >
            OVER <tspan fill="var(--text)">(PARTITION BY user_id)</tspan>
          </text>
          <text
            x="20"
            y="166"
            fill="var(--syntax-keyword)"
            fontFamily="IBM Plex Mono"
            fontSize="11"
          >
            FROM <tspan fill="var(--syntax-string)">audit_log</tspan>
          </text>

          {/* Caret 2: Marcus */}
          <rect x="180" y="106" width="2" height="14" fill="var(--color-verdigris)" />
          <rect x="184" y="98" width="46" height="14" rx="2" fill="var(--color-verdigris)" />
          <text
            x="188"
            y="109"
            fill="var(--bg)"
            fontFamily="IBM Plex Mono"
            fontSize="9"
            fontWeight="600"
          >
            Marcus
          </text>
        </g>

        {/* Sheet 1: Dijkstra in TypeScript (front, rotated -1deg) */}
        <g transform="translate(90, 40) rotate(-1)">
          <rect
            width="310"
            height="410"
            rx="4"
            fill="var(--bg)"
            stroke="var(--brass-500)"
            strokeWidth="1"
            filter="url(#shadow-sheet-svg)"
          />
          <text x="24" y="32" fill="var(--accent)" fontFamily="IBM Plex Mono" fontSize="10">
            dijkstra.ts
          </text>
          <line x1="24" y1="42" x2="286" y2="42" stroke="var(--border)" strokeWidth="1" />
          <text x="24" y="72" fill="var(--syntax-comment)" fontFamily="IBM Plex Mono" fontSize="11">
            // Dijkstra's Shortest Path
          </text>
          <text x="24" y="98" fill="var(--syntax-keyword)" fontFamily="IBM Plex Mono" fontSize="11">
            function <tspan fill="var(--text)">dijkstra(g: Graph, s: Node)</tspan> {'{'}
          </text>
          <text
            x="44"
            y="122"
            fill="var(--syntax-keyword)"
            fontFamily="IBM Plex Mono"
            fontSize="11"
          >
            const <tspan fill="var(--text)">dist = new Map();</tspan>
          </text>
          <text x="44" y="146" fill="var(--text)" fontFamily="IBM Plex Mono" fontSize="11">
            dist.set(s, <tspan fill="var(--syntax-number)">0</tspan>);
          </text>
          <text
            x="44"
            y="170"
            fill="var(--syntax-keyword)"
            fontFamily="IBM Plex Mono"
            fontSize="11"
          >
            while <tspan fill="var(--text)">(!pq.isEmpty()) {'{'}</tspan>
          </text>
          <text
            x="64"
            y="194"
            fill="var(--syntax-keyword)"
            fontFamily="IBM Plex Mono"
            fontSize="11"
          >
            const <tspan fill="var(--text)">curr = pq.dequeue();</tspan>
          </text>
          <text
            x="64"
            y="218"
            fill="var(--syntax-keyword)"
            fontFamily="IBM Plex Mono"
            fontSize="11"
          >
            for <tspan fill="var(--text)">(const edge of g.edges(curr))</tspan>
          </text>
          <text x="44" y="242" fill="var(--text)" fontFamily="IBM Plex Mono" fontSize="11">
            {'}'}
          </text>
          <text
            x="44"
            y="266"
            fill="var(--syntax-keyword)"
            fontFamily="IBM Plex Mono"
            fontSize="11"
          >
            return <tspan fill="var(--text)">dist;</tspan>
          </text>
          <text x="24" y="290" fill="var(--text)" fontFamily="IBM Plex Mono" fontSize="11">
            {'}'}
          </text>

          {/* Caret 1: Priya */}
          <rect x="228" y="110" width="2" height="14" fill="var(--color-vermilion)" />
          <rect x="232" y="102" width="38" height="14" rx="2" fill="var(--color-vermilion)" />
          <text
            x="236"
            y="113"
            fill="var(--paper-100)"
            fontFamily="IBM Plex Mono"
            fontSize="9"
            fontWeight="600"
          >
            Priya
          </text>

          {/* Caret 3: Ana */}
          <rect x="180" y="182" width="2" height="14" fill="var(--color-cobalt)" />
          <rect x="184" y="174" width="28" height="14" rx="2" fill="var(--color-cobalt)" />
          <text
            x="188"
            y="185"
            fill="var(--paper-100)"
            fontFamily="IBM Plex Mono"
            fontSize="9"
            fontWeight="600"
          >
            Ana
          </text>
        </g>
      </svg>
    </div>
  );
}
