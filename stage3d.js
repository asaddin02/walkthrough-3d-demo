import * as THREE from './assets/vendor/three.module.js';

function createRoundedCardShape(width, height, radius) {
  const s = new THREE.Shape();
  const x = -width / 2;
  const y = -height / 2;
  s.moveTo(x + radius, y);
  s.lineTo(x + width - radius, y);
  s.quadraticCurveTo(x + width, y, x + width, y + radius);
  s.lineTo(x + width, y + height - radius);
  s.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  s.lineTo(x + radius, y + height);
  s.quadraticCurveTo(x, y + height, x, y + height - radius);
  s.lineTo(x, y + radius);
  s.quadraticCurveTo(x, y, x + radius, y);
  return s;
}

function normalizeFrontUVs(geometry, width, height) {
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    uv.setXY(i, (px + width / 2) / width, (py + height / 2) / height);
  }
  uv.needsUpdate = true;
}

function drawCardFaceCanvas(project, image) {
  const w = 720;
  const h = 1000;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Obsidian card body
  ctx.fillStyle = '#0e1117';
  ctx.fillRect(0, 0, w, h);

  // Subtle architectural outer hairline
  ctx.strokeStyle = 'rgba(224, 164, 88, 0.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(20, 20, w - 40, h - 40);

  // Inner architectural frame for real render
  const padX = 36;
  const topY = 92;
  const imgW = w - padX * 2;
  const imgH = 740;

  ctx.save();
  ctx.beginPath();
  ctx.rect(padX, topY, imgW, imgH);
  ctx.clip();

  if (image && image.width > 0) {
    const srcRatio = image.width / image.height;
    const dstRatio = imgW / imgH;
    let drawW = imgW;
    let drawH = imgH;
    let dx = padX;
    let dy = topY;
    if (srcRatio > dstRatio) {
      drawW = imgH * srcRatio;
      dx = padX - (drawW - imgW) / 2;
    } else {
      drawH = imgW / srcRatio;
      dy = topY - (drawH - imgH) / 2;
    }
    ctx.drawImage(image, dx, dy, drawW, drawH);
  } else {
    ctx.fillStyle = '#141821';
    ctx.fillRect(padX, topY, imgW, imgH);
  }

  // Subtle vignette at bottom edge of image frame for crisp contrast against gold hairline
  const grad = ctx.createLinearGradient(0, topY + imgH - 120, 0, topY + imgH);
  grad.addColorStop(0, 'rgba(12, 14, 18, 0)');
  grad.addColorStop(1, 'rgba(12, 14, 18, 0.55)');
  ctx.fillStyle = grad;
  ctx.fillRect(padX, topY + imgH - 120, imgW, 120);
  ctx.restore();

  // Inner gold hairline border around artwork
  ctx.strokeStyle = 'rgba(224, 164, 88, 0.42)';
  ctx.lineWidth = 2;
  ctx.strokeRect(padX, topY, imgW, imgH);

  // Top bar: playing card rank + architectural index
  ctx.fillStyle = '#e0a458';
  ctx.font = '600 34px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(project.rank, 38, 56);

  ctx.fillStyle = '#9ba1ae';
  ctx.font = '500 21px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillText(project.suit, w - 38, 56);

  // Bottom editorial nameplate
  ctx.fillStyle = '#f4f0e8';
  ctx.font = '500 38px "Cormorant Garamond", Georgia, serif';
  ctx.textAlign = 'left';
  ctx.fillText(project.title, 38, 884);

  ctx.fillStyle = '#c5c1b8';
  ctx.font = '400 21px "DM Sans", sans-serif';
  ctx.fillText(project.specs.footprint, 38, 932);

  ctx.fillStyle = '#e0a458';
  ctx.font = '500 22px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillText(project.gumroadPrice, w - 38, 932);

  return canvas;
}

function createDraftingFloorTexture() {
  const size = 1024;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#090b0f';
  ctx.fillRect(0, 0, size, size);

  // Subtle radial warm studio bounce under the card fan
  const rad = ctx.createRadialGradient(size / 2, size / 2, 20, size / 2, size / 2, size * 0.48);
  rad.addColorStop(0, 'rgba(224, 164, 88, 0.08)');
  rad.addColorStop(0.55, 'rgba(24, 28, 36, 0.16)');
  rad.addColorStop(1, 'rgba(9, 11, 15, 0)');
  ctx.fillStyle = rad;
  ctx.fillRect(0, 0, size, size);

  // Subtle architectural drafting lines on the slate plinth
  ctx.strokeStyle = 'rgba(224, 164, 88, 0.10)';
  ctx.lineWidth = 1;
  const step = 64;
  for (let i = step; i < size; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(size, i);
    ctx.stroke();
  }

  // Concentric architectural arc marker
  ctx.strokeStyle = 'rgba(224, 164, 88, 0.18)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2 + 80, 340, Math.PI * 1.12, Math.PI * 1.88);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function initCardStage({
  viewportEl,
  canvasEl,
  projects,
  onFocusChange,
  onSelectProject,
}) {
  if (!viewportEl || !canvasEl) return null;

  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let isPaused = reducedMotionQuery.matches;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas: canvasEl,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
  } catch {
    return null;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x090b0f);
  scene.fog = new THREE.Fog(0x090b0f, 10, 22);

  const camera = new THREE.PerspectiveCamera(34, 16 / 10.6, 0.1, 40);
  camera.position.set(0, 0.42, 8.6);
  camera.lookAt(0, 0.05, 0);

  // Physically balanced studio lighting (warm champagne key + cool slate fill + gold rim)
  const ambient = new THREE.AmbientLight(0xdbe2ee, 0.72);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xffe4bc, 2.35);
  keyLight.position.set(4.5, 6.2, 6.8);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0xe0a458, 1.8);
  rimLight.position.set(-5.8, 3.6, -2.5);
  scene.add(rimLight);

  const coolFill = new THREE.DirectionalLight(0x88a2c8, 0.85);
  coolFill.position.set(-4.2, -1.5, 5.2);
  scene.add(coolFill);

  // Subtle architectural drafting surface below the fanned hand
  const floorGeo = new THREE.PlaneGeometry(16, 12);
  const floorMat = new THREE.MeshStandardMaterial({
    map: createDraftingFloorTexture(),
    roughness: 0.72,
    metalness: 0.18,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -1.78, -0.4);
  scene.add(floor);

  // Shared card geometry (beveled obsidian & brushed gold slab)
  const cardW = 1.64;
  const cardH = 2.30;
  const cardRadius = 0.10;
  const shape = createRoundedCardShape(cardW, cardH, cardRadius);
  const cardGeo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.036,
    bevelEnabled: true,
    bevelThickness: 0.016,
    bevelSize: 0.016,
    bevelSegments: 3,
    curveSegments: 16,
  });
  cardGeo.center();
  normalizeFrontUVs(cardGeo, cardW, cardH);

  const goldEdgeMat = new THREE.MeshStandardMaterial({
    color: 0xe0a458,
    metalness: 0.88,
    roughness: 0.24,
  });

  const rig = new THREE.Group();
  rig.position.set(0, 0.04, 0);
  scene.add(rig);

  // Fan layout for 6 cards (5 residences + Borneo Ace) with clear staggered depth
  const count = projects.length;
  const cardEntries = [];
  let hoveredIndex = -1;
  let focusedIndex = -1;

  projects.forEach((project, idx) => {
    const t = count > 1 ? idx / (count - 1) - 0.5 : 0; // -0.5 to +0.5
    const baseX = t * 5.75;
    const baseY = -t * t * 1.45 + 0.16;
    const baseZ = idx * 0.11 - 0.28;
    const baseRotZ = -t * 0.34;
    const baseRotY = -t * 0.16;

    // Initial placeholder canvas texture so card draws immediately while WebP loads
    const initialCanvas = drawCardFaceCanvas(project, null);
    const faceTex = new THREE.CanvasTexture(initialCanvas);
    faceTex.colorSpace = THREE.SRGBColorSpace;
    faceTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    const faceMat = new THREE.MeshStandardMaterial({
      map: faceTex,
      roughness: 0.34,
      metalness: 0.14,
    });

    const mesh = new THREE.Mesh(cardGeo, [faceMat, goldEdgeMat]);
    mesh.position.set(baseX, baseY, baseZ);
    mesh.rotation.set(0, baseRotY, baseRotZ);
    mesh.userData = { index: idx, project };
    rig.add(mesh);

    const entry = {
      mesh,
      faceTex,
      faceMat,
      project,
      baseX,
      baseY,
      baseZ,
      baseRotZ,
      baseRotY,
      lift: 0,
    };
    cardEntries.push(entry);

    // Load real architectural WebP onto card face
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const updated = drawCardFaceCanvas(project, img);
      faceTex.image = updated;
      faceTex.needsUpdate = true;
      renderOnce();
    };
    img.src = project.cardImage;
  });

  // Pointer, animation & raycaster state (declared before updateSize/renderOnce)
  const raycaster = new THREE.Raycaster();
  const pointerNDC = new THREE.Vector2(99, 99);
  const pointerTarget = { x: 0, y: 0 };
  const pointerCurrent = { x: 0, y: 0 };
  let isPointerInside = false;
  let rafId = 0;
  let elapsed = 0;
  let lastTime = performance.now();

  function updateSize() {
    const rect = viewportEl.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.aspect = aspect;

    // Fit full 6-card fan cleanly across desktop, tablet, and narrow mobile viewports
    const targetSpanX = 7.9;
    const vFovRad = THREE.MathUtils.degToRad(camera.fov);
    const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect);
    const neededZForWidth = (targetSpanX / 2) / Math.tan(hFovRad / 2);
    const neededZForHeight = 3.65 / (2 * Math.tan(vFovRad / 2));
    camera.position.z = Math.max(7.6, neededZForWidth * 1.08, neededZForHeight * 1.12);
    camera.updateProjectionMatrix();
    renderOnce();
  }

  function updatePointer(clientX, clientY) {
    const rect = canvasEl.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    pointerNDC.set(nx, ny);
    pointerTarget.x = nx;
    pointerTarget.y = ny;
  }

  function pickCard() {
    if (!isPointerInside) return -1;
    raycaster.setFromCamera(pointerNDC, camera);
    const hits = raycaster.intersectObjects(
      cardEntries.map((c) => c.mesh),
      false
    );
    if (hits.length > 0) {
      return hits[0].object.userData.index;
    }
    return -1;
  }

  canvasEl.addEventListener('pointermove', (e) => {
    isPointerInside = true;
    updatePointer(e.clientX, e.clientY);
    const hit = pickCard();
    if (hit !== hoveredIndex) {
      hoveredIndex = hit;
      canvasEl.dataset.hover = hit >= 0 ? 'card' : '';
      if (hit >= 0) {
        focusedIndex = hit;
        if (onFocusChange) onFocusChange(projects[hit], hit);
      }
    }
    if (isPaused) renderOnce();
  });

  canvasEl.addEventListener('pointerleave', () => {
    isPointerInside = false;
    hoveredIndex = -1;
    canvasEl.dataset.hover = '';
    pointerTarget.x = 0;
    pointerTarget.y = 0;
    if (isPaused) renderOnce();
  });

  canvasEl.addEventListener('click', (e) => {
    isPointerInside = true;
    updatePointer(e.clientX, e.clientY);
    const hit = pickCard();
    if (hit >= 0 && onSelectProject) {
      onSelectProject(projects[hit]);
    }
  });

  const ro = new ResizeObserver(() => updateSize());
  ro.observe(viewportEl);
  updateSize();

  function step(dt) {
    if (!isPaused) {
      elapsed += dt;
    }

    pointerCurrent.x += (pointerTarget.x - pointerCurrent.x) * Math.min(1, dt * 6);
    pointerCurrent.y += (pointerTarget.y - pointerCurrent.y) * Math.min(1, dt * 6);

    const idleYaw = isPaused ? 0 : Math.sin(elapsed * 0.45) * 0.055;
    const idlePitch = isPaused ? 0 : Math.cos(elapsed * 0.35) * 0.025;

    rig.rotation.y = pointerCurrent.x * 0.14 + idleYaw;
    rig.rotation.x = -pointerCurrent.y * 0.06 + idlePitch;

    const activeIdx = hoveredIndex >= 0 ? hoveredIndex : focusedIndex;

    for (let i = 0; i < cardEntries.length; i++) {
      const c = cardEntries[i];
      const isActive = i === activeIdx;
      const targetLift = isActive ? 1 : 0;
      c.lift += (targetLift - c.lift) * Math.min(1, dt * 9);

      const floatY = isPaused ? 0 : Math.sin(elapsed * 0.9 + i * 0.85) * 0.035;
      c.mesh.position.x = c.baseX;
      c.mesh.position.y = c.baseY + floatY + c.lift * 0.38;
      c.mesh.position.z = c.baseZ + c.lift * 0.88;
      c.mesh.rotation.z = c.baseRotZ * (1 - c.lift * 0.55);
      c.mesh.rotation.y = c.baseRotY * (1 - c.lift * 0.7);
    }

    renderer.render(scene, camera);
  }

  function renderOnce() {
    step(0.016);
  }

  function loop(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    step(dt);
    if (!isPaused) {
      rafId = requestAnimationFrame(loop);
    } else {
      rafId = 0;
    }
  }

  // Mark stage ready so static fallback crossfades smoothly away
  viewportEl.dataset.webgl = 'ready';
  renderOnce();
  if (!isPaused) {
    rafId = requestAnimationFrame(loop);
  }

  return {
    focusCard(index) {
      if (index < 0 || index >= projects.length) return;
      focusedIndex = index;
      hoveredIndex = -1;
      if (onFocusChange) onFocusChange(projects[index], index);
      if (isPaused) {
        // Snap smoothly in a brief settle render
        for (let k = 0; k < 18; k++) step(0.05);
      }
    },
    setPaused(paused) {
      isPaused = Boolean(paused);
      if (!isPaused && !rafId) {
        lastTime = performance.now();
        rafId = requestAnimationFrame(loop);
      } else if (isPaused && rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
        renderOnce();
      }
    },
    isPaused() {
      return isPaused;
    },
  };
}
