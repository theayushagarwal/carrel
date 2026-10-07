import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { LobbySvgFallback } from './LobbySvgFallback';

// Active renderer tracker to guarantee at most one WebGL context exists
let activeRenderer: THREE.WebGLRenderer | null = null;

function getTokens() {
  if (typeof window === 'undefined') {
    return {
      bg: 'rgb(20, 17, 15)',
      panel: 'rgb(26, 22, 19)',
      raised: 'rgb(33, 28, 24)',
      border: 'rgb(48, 42, 36)',
      text: 'rgb(237, 230, 218)',
      muted: 'rgb(163, 154, 139)',
      keyword: 'rgb(235, 199, 122)',
      string: 'rgb(79, 163, 154)',
      number: 'rgb(201, 138, 43)',
      comment: 'rgb(163, 154, 139)',
      accent: 'rgb(217, 164, 65)',
      vermilion: 'rgb(210, 84, 58)',
      verdigris: 'rgb(79, 163, 154)',
      cobalt: 'rgb(59, 130, 246)',
    };
  }
  const s = getComputedStyle(document.documentElement);
  return {
    bg: s.getPropertyValue('--bg').trim() || 'rgb(20, 17, 15)',
    panel: s.getPropertyValue('--panel').trim() || 'rgb(26, 22, 19)',
    raised: s.getPropertyValue('--raised').trim() || 'rgb(33, 28, 24)',
    border: s.getPropertyValue('--border').trim() || 'rgb(48, 42, 36)',
    text: s.getPropertyValue('--text').trim() || 'rgb(237, 230, 218)',
    muted: s.getPropertyValue('--muted').trim() || 'rgb(163, 154, 139)',
    keyword: s.getPropertyValue('--syntax-keyword').trim() || 'rgb(235, 199, 122)',
    string: s.getPropertyValue('--syntax-string').trim() || 'rgb(79, 163, 154)',
    number: s.getPropertyValue('--syntax-number').trim() || 'rgb(201, 138, 43)',
    comment: s.getPropertyValue('--syntax-comment').trim() || 'rgb(163, 154, 139)',
    accent: s.getPropertyValue('--accent').trim() || 'rgb(217, 164, 65)',
    vermilion: s.getPropertyValue('--color-vermilion').trim() || 'rgb(210, 84, 58)',
    verdigris: s.getPropertyValue('--color-verdigris').trim() || 'rgb(79, 163, 154)',
    cobalt: s.getPropertyValue('--color-cobalt').trim() || 'rgb(59, 130, 246)',
  };
}

function drawSheetCanvas(
  title: string,
  lines: Array<Array<{ text: string; color: string }>>,
  bgColor: string,
  borderColor: string,
  titleColor: string,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 810;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // Background
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, 600, 810);

  // Border
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 598, 808);

  // Header
  ctx.font = '500 18px "IBM Plex Mono", monospace';
  ctx.fillStyle = titleColor;
  ctx.fillText(title, 36, 52);

  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(36, 70);
  ctx.lineTo(564, 70);
  ctx.stroke();

  // Code lines (17px with 36px margin ensures zero right edge clipping)
  ctx.font = '400 17px "IBM Plex Mono", monospace';
  let y = 116;
  const lineHeight = 33;

  for (const line of lines) {
    let x = 36;
    for (const token of line) {
      ctx.fillStyle = token.color;
      ctx.fillText(token.text, x, y);
      x += ctx.measureText(token.text).width;
    }
    y += lineHeight;
  }

  return canvas;
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0.45)');
    gradient.addColorStop(0.5, 'rgba(0, 0, 0, 0.2)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 256);
  }
  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

export default function LobbyScene() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [fallbackMode, setFallbackMode] = useState(false);

  useEffect(() => {
    // Check WebGL availability, reduced motion, and viewport width
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isMobile = window.innerWidth < 768;

    let hasWebGL = false;
    try {
      const testCanvas = document.createElement('canvas');
      hasWebGL = !!(
        window.WebGLRenderingContext &&
        (testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl'))
      );
    } catch {
      hasWebGL = false;
    }

    if (prefersReducedMotion || isMobile || !hasWebGL) {
      setFallbackMode(true);
      return;
    }

    let isDisposed = false;
    let animFrameId = 0;
    let observer: IntersectionObserver | null = null;
    let isVisible = true;

    // Dispose any previous renderer immediately
    if (activeRenderer) {
      try {
        activeRenderer.dispose();
        activeRenderer.forceContextLoss();
      } catch {}
      activeRenderer = null;
    }

    const container = containerRef.current;
    if (!container) return;

    // Wait for fonts before drawing textures
    document.fonts.ready.then(() => {
      if (isDisposed) return;
      initScene();
    });

    let renderer: THREE.WebGLRenderer | null = null;
    let scene: THREE.Scene | null = null;
    let camera: THREE.PerspectiveCamera | null = null;

    const texturesToDispose: THREE.Texture[] = [];
    const materialsToDispose: THREE.Material[] = [];
    const geometriesToDispose: THREE.BufferGeometry[] = [];

    function initScene() {
      if (isDisposed || !container) return;

      const width = container.clientWidth || 540;
      const height = container.clientHeight || 560;

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
      camera.position.set(0, 0, 8.8);

      try {
        renderer = new THREE.WebGLRenderer({
          alpha: true,
          antialias: true,
          powerPreference: 'high-performance',
        });
      } catch {
        setFallbackMode(true);
        return;
      }

      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      renderer.setClearColor(0x000000, 0);
      activeRenderer = renderer;

      const domElement = renderer.domElement;
      domElement.setAttribute('data-testid', 'lobby-three-canvas');
      domElement.style.width = '100%';
      domElement.style.height = '100%';
      domElement.style.display = 'block';
      container.appendChild(domElement);

      const colors = getTokens();

      // Lighting
      const ambientLight = new THREE.AmbientLight(new THREE.Color(colors.text), 0.7);
      scene.add(ambientLight);

      const pointLight = new THREE.PointLight(new THREE.Color(colors.accent), 2.2, 30);
      pointLight.position.set(-3.5, 4.5, 5);
      scene.add(pointLight);

      // Fake Contact Shadow plane
      const shadowTex = createContactShadowTexture();
      texturesToDispose.push(shadowTex);
      const shadowGeo = new THREE.PlaneGeometry(6.4, 2.4);
      geometriesToDispose.push(shadowGeo);
      const shadowMat = new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
      });
      materialsToDispose.push(shadowMat);
      const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
      shadowMesh.position.set(0.1, -2.4, -0.4);
      scene.add(shadowMesh);

      // Root group for mouse parallax and drift
      const paperGroup = new THREE.Group();
      scene.add(paperGroup);

      const sheetRatio = 1 / 1.35;
      const sheetWidth = 3.2;
      const sheetHeight = sheetWidth / sheetRatio;
      const planeGeo = new THREE.PlaneGeometry(sheetWidth, sheetHeight);
      geometriesToDispose.push(planeGeo);

      // Sheet 3: Python snippet (back)
      const pythonLines = [
        [{ text: '# Concurrent stream queue', color: colors.comment }],
        [
          { text: 'async def ', color: colors.keyword },
          { text: 'stream_presence', color: colors.text },
          { text: '(room_id):', color: colors.text },
        ],
        [
          { text: '    queue = ', color: colors.text },
          { text: 'asyncio.Queue', color: colors.keyword },
          { text: '(maxsize=', color: colors.text },
          { text: '128', color: colors.number },
          { text: ')', color: colors.text },
        ],
        [
          { text: '    listener = ', color: colors.text },
          { text: 'subscribe', color: colors.keyword },
          { text: '(queue.put)', color: colors.text },
        ],
        [{ text: '    try:', color: colors.keyword }],
        [
          { text: '        while ', color: colors.keyword },
          { text: 'True', color: colors.number },
          { text: ':', color: colors.text },
        ],
        [
          { text: '            ev = ', color: colors.text },
          { text: 'await ', color: colors.keyword },
          { text: 'queue.get()', color: colors.text },
        ],
        [
          { text: '            yield ', color: colors.keyword },
          { text: 'ev', color: colors.text },
        ],
        [{ text: '    finally:', color: colors.keyword }],
        [{ text: '        listener.cancel()', color: colors.text }],
      ];
      const canvas3 = drawSheetCanvas(
        'stream.py',
        pythonLines,
        colors.raised,
        colors.border,
        colors.muted,
      );
      const tex3 = new THREE.CanvasTexture(canvas3);
      texturesToDispose.push(tex3);
      const mat3 = new THREE.MeshStandardMaterial({
        map: tex3,
        roughness: 0.85,
        metalness: 0.05,
      });
      materialsToDispose.push(mat3);
      const sheet3 = new THREE.Mesh(planeGeo, mat3);
      sheet3.position.set(0.3, 0.2, -0.3);
      sheet3.rotation.set(0.04, 0.02, -0.1);
      paperGroup.add(sheet3);

      // Sheet 2: SQL Window Functions (middle)
      const sqlLines = [
        [{ text: '-- Cumulative room metrics', color: colors.comment }],
        [{ text: 'WITH ranked_events AS (', color: colors.keyword }],
        [
          { text: '  SELECT ', color: colors.keyword },
          { text: 'user_id,', color: colors.text },
        ],
        [
          { text: '    COUNT', color: colors.keyword },
          { text: '(*) OVER (', color: colors.text },
        ],
        [
          { text: '      PARTITION BY ', color: colors.keyword },
          { text: 'user_id', color: colors.text },
        ],
        [
          { text: '      ORDER BY ', color: colors.keyword },
          { text: 'created_at', color: colors.text },
        ],
        [
          { text: '    ) AS ', color: colors.keyword },
          { text: 'active_sessions', color: colors.text },
        ],
        [
          { text: '  FROM ', color: colors.keyword },
          { text: 'audit_log', color: colors.string },
        ],
        [{ text: ') SELECT * FROM ranked_events;', color: colors.keyword }],
      ];
      const canvas2 = drawSheetCanvas(
        'metrics.sql',
        sqlLines,
        colors.panel,
        colors.border,
        colors.muted,
      );
      const tex2 = new THREE.CanvasTexture(canvas2);
      texturesToDispose.push(tex2);
      const mat2 = new THREE.MeshStandardMaterial({
        map: tex2,
        roughness: 0.85,
        metalness: 0.05,
      });
      materialsToDispose.push(mat2);
      const sheet2 = new THREE.Mesh(planeGeo, mat2);
      sheet2.position.set(0.1, 0.1, -0.15);
      sheet2.rotation.set(-0.02, -0.01, 0.07);
      paperGroup.add(sheet2);

      // Sheet 1: Dijkstra in TypeScript (front)
      const tsLines = [
        [{ text: "// Dijkstra's Shortest Path", color: colors.comment }],
        [
          { text: 'function ', color: colors.keyword },
          { text: 'dijkstra', color: colors.text },
          { text: '(graph: Graph, start: NodeId) {', color: colors.text },
        ],
        [
          { text: '  const ', color: colors.keyword },
          { text: 'dist = new Map<NodeId, number>();', color: colors.text },
        ],
        [
          { text: '  const ', color: colors.keyword },
          { text: 'pq = new PriorityQueue();', color: colors.text },
        ],
        [
          { text: '  dist.set(start, ', color: colors.text },
          { text: '0', color: colors.number },
          { text: ');', color: colors.text },
        ],
        [
          { text: '  while ', color: colors.keyword },
          { text: '(!pq.isEmpty()) {', color: colors.text },
        ],
        [
          { text: '    const ', color: colors.keyword },
          { text: 'curr = pq.dequeue()!;', color: colors.text },
        ],
        [{ text: '    for (const edge of graph.neighbors(curr)) {', color: colors.text }],
        [{ text: '      const alt = dist.get(curr)! + edge.weight;', color: colors.text }],
        [{ text: '      dist.set(edge.to, alt);', color: colors.text }],
        [{ text: '    }', color: colors.text }],
        [{ text: '  }', color: colors.text }],
        [
          { text: '  return ', color: colors.keyword },
          { text: 'dist;', color: colors.text },
        ],
        [{ text: '}', color: colors.text }],
      ];
      const canvas1 = drawSheetCanvas(
        'dijkstra.ts',
        tsLines,
        colors.bg,
        colors.accent,
        colors.accent,
      );
      const tex1 = new THREE.CanvasTexture(canvas1);
      texturesToDispose.push(tex1);
      const mat1 = new THREE.MeshStandardMaterial({
        map: tex1,
        roughness: 0.85,
        metalness: 0.05,
      });
      materialsToDispose.push(mat1);
      const sheet1 = new THREE.Mesh(planeGeo, mat1);
      sheet1.position.set(-0.15, -0.05, 0);
      sheet1.rotation.set(0, 0, -0.015);
      paperGroup.add(sheet1);

      // Create 3 tiny carets with name flags on Sheet 1
      function createCaret(name: string, colorHex: string): THREE.Group {
        const caretGroup = new THREE.Group();
        const barGeo = new THREE.PlaneGeometry(0.04, 0.22);
        geometriesToDispose.push(barGeo);
        const barMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex) });
        materialsToDispose.push(barMat);
        const bar = new THREE.Mesh(barGeo, barMat);
        caretGroup.add(bar);

        // Name flag
        const flagCanvas = document.createElement('canvas');
        flagCanvas.width = 128;
        flagCanvas.height = 36;
        const fctx = flagCanvas.getContext('2d');
        if (fctx) {
          fctx.fillStyle = colorHex;
          fctx.fillRect(0, 0, 128, 36);
          fctx.fillStyle = 'white';
          fctx.font = '600 20px "IBM Plex Mono", monospace';
          fctx.fillText(name, 12, 25);
        }
        const flagTex = new THREE.CanvasTexture(flagCanvas);
        texturesToDispose.push(flagTex);
        const flagGeo = new THREE.PlaneGeometry(0.48, 0.14);
        geometriesToDispose.push(flagGeo);
        const flagMat = new THREE.MeshBasicMaterial({ map: flagTex, transparent: true });
        materialsToDispose.push(flagMat);
        const flag = new THREE.Mesh(flagGeo, flagMat);
        flag.position.set(0.26, 0.12, 0);
        caretGroup.add(flag);

        return caretGroup;
      }

      const caretPriya = createCaret('Priya', colors.vermilion);
      caretPriya.position.set(0.4, 0.8, 0.02);
      sheet1.add(caretPriya);

      const caretMarcus = createCaret('Marcus', colors.verdigris);
      caretMarcus.position.set(-0.2, 0.1, 0.02);
      sheet1.add(caretMarcus);

      const caretAna = createCaret('Ana', colors.cobalt);
      caretAna.position.set(0.6, -0.6, 0.02);
      sheet1.add(caretAna);

      // Store memory info for automated leak test assertion
      (window as any).__three_memory = {
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
      };

      // Mouse Parallax & Springs
      let mouseX = 0;
      let mouseY = 0;
      let currentRotX = 0;
      let currentRotY = 0;

      const handlePointerMove = (e: PointerEvent) => {
        const rect = container.getBoundingClientRect();
        const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
        mouseX = Math.max(-1, Math.min(1, nx));
        mouseY = Math.max(-1, Math.min(1, ny));
      };
      window.addEventListener('pointermove', handlePointerMove, { passive: true });

      // Resize handler
      const handleResize = () => {
        if (!container || !renderer || !camera) return;
        const w = container.clientWidth || 540;
        const h = container.clientHeight || 560;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      window.addEventListener('resize', handleResize, { passive: true });

      // Theme change observer: re-read tokens and recolor
      const themeObserver = new MutationObserver(() => {
        const nextColors = getTokens();
        ambientLight.color.set(nextColors.text);
        pointLight.color.set(nextColors.accent);
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });

      // Visibility & Intersection Observers
      const handleVisibilityChange = () => {
        isVisible = document.visibilityState === 'visible';
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);

      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            isVisible = entry.isIntersecting && document.visibilityState === 'visible';
          }
        },
        { threshold: 0.1 },
      );
      observer.observe(container);

      // Render Loop
      const startTime = performance.now();
      const maxParallax = (6 * Math.PI) / 180; // +-6 degrees

      const animate = (now: number) => {
        if (isDisposed) return;
        animFrameId = requestAnimationFrame(animate);

        if (!isVisible || !renderer || !scene || !camera) return;

        const time = (now - startTime) * 0.001;

        // Caret 1Hz blink
        const blinkVisible = time % 1.0 < 0.5;
        caretPriya.visible = blinkVisible;
        caretMarcus.visible = blinkVisible;
        caretAna.visible = blinkVisible;

        // Caret step drift
        caretPriya.position.x = 0.4 + Math.sin(time * 0.8) * 0.25;
        caretMarcus.position.x = -0.2 + Math.cos(time * 0.6) * 0.3;
        caretAna.position.x = 0.6 + Math.sin(time * 0.5) * 0.2;

        // Idle drift (0.1 rad/s) + Parallax with damped spring
        const targetRotY = mouseX * maxParallax + Math.sin(time * 0.1) * 0.03;
        const targetRotX = -mouseY * maxParallax + Math.cos(time * 0.1) * 0.02;

        currentRotX += (targetRotX - currentRotX) * 0.08;
        currentRotY += (targetRotY - currentRotY) * 0.08;

        paperGroup.rotation.x = currentRotX;
        paperGroup.rotation.y = currentRotY;

        renderer.render(scene, camera);
      };

      animFrameId = requestAnimationFrame(animate);
      setIsReady(true);

      // Cleanup function attached to unmount
      return () => {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('resize', handleResize);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        themeObserver.disconnect();
        if (observer) observer.disconnect();
      };
    }

    return () => {
      isDisposed = true;
      if (animFrameId) cancelAnimationFrame(animFrameId);

      // Dispose all resources
      for (const t of texturesToDispose) t.dispose();
      for (const m of materialsToDispose) m.dispose();
      for (const g of geometriesToDispose) g.dispose();

      if (renderer) {
        try {
          renderer.dispose();
          renderer.forceContextLoss();
          if (renderer.domElement && renderer.domElement.parentNode) {
            renderer.domElement.parentNode.removeChild(renderer.domElement);
          }
        } catch {}
      }

      if (activeRenderer === renderer) {
        activeRenderer = null;
      }

      // Record 0 for memory test after cleanup
      (window as any).__three_memory = {
        geometries: 0,
        textures: 0,
      };
    };
  }, []);

  if (fallbackMode) {
    return <LobbySvgFallback />;
  }

  return (
    <div className="lobby-scene-container" ref={containerRef} data-testid="lobby-scene">
      {/* Show SVG fallback while canvas initializes, then crossfade */}
      <div
        className={`lobby-fallback-crossfade ${isReady ? 'fade-out' : 'fade-in'}`}
        aria-hidden={isReady}
      >
        <LobbySvgFallback />
      </div>
    </div>
  );
}
