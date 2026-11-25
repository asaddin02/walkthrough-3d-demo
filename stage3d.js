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

function createRoundedFaceGeometry(width, height, radius) {
  const shape = createRoundedCardShape(width, height, radius);
  const geo = new THREE.ShapeGeometry(shape, 14);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, (pos.getX(i) + width / 2) / width, (pos.getY(i) + height / 2) / height);
  }
  uv.needsUpdate = true;
  return geo;
}

function drawCardFrontCanvas(project, image) {
  const w = 720;
  const h = 1000;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Obsidian matte body
  ctx.fillStyle = '#0e1117';
  ctx.fillRect(0, 0, w, h);

  // Outer brushed-gold architectural frame
  ctx.strokeStyle = 'rgba(224, 164, 88, 0.56)';
  ctx.lineWidth = 3;
  ctx.strokeRect(20, 20, w - 40, h - 40);

  // Render viewport
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

  const grad = ctx.createLinearGradient(0, topY + imgH - 130, 0, topY + imgH);
  grad.addColorStop(0, 'rgba(12, 14, 18, 0)');
  grad.addColorStop(1, 'rgba(12, 14, 18, 0.58)');
  ctx.fillStyle = grad;
  ctx.fillRect(padX, topY + imgH - 130, imgW, 130);
  ctx.restore();

  ctx.strokeStyle = 'rgba(224, 164, 88, 0.42)';
  ctx.lineWidth = 2;
  ctx.strokeRect(padX, topY, imgW, imgH);

  // Top index bar
  ctx.fillStyle = '#e0a458';
  ctx.font = '600 34px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(project.rank, 38, 56);

  ctx.fillStyle = '#9ba1ae';
  ctx.font = '500 21px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillText(project.suit, w - 38, 56);

  // Bottom nameplate (architectural scale, zero pricing)
  ctx.fillStyle = '#f4f0e8';
  ctx.font = '500 38px "Cormorant Garamond", Georgia, serif';
  ctx.textAlign = 'left';
  ctx.fillText(project.title, 38, 884);

  ctx.fillStyle = '#c5c1b8';
  ctx.font = '400 21px "DM Sans", sans-serif';
  ctx.fillText(project.disciplineLabel, 38, 932);

  ctx.fillStyle = '#e0a458';
  ctx.font = '500 22px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillText(project.scaleBadge, w - 38, 932);

  return canvas;
}

function drawCardBackCanvas(project) {
  const w = 720;
  const h = 1000;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Deep obsidian architectural blueprint backing
  ctx.fillStyle = '#0c0f15';
  ctx.fillRect(0, 0, w, h);

  // Fine drafting grid
  ctx.strokeStyle = 'rgba(224, 164, 88, 0.08)';
  ctx.lineWidth = 1;
  for (let gx = 40; gx < w; gx += 40) {
    ctx.beginPath();
    ctx.moveTo(gx, 24);
    ctx.lineTo(gx, h - 24);
    ctx.stroke();
  }
  for (let gy = 40; gy < h; gy += 40) {
    ctx.beginPath();
    ctx.moveTo(24, gy);
    ctx.lineTo(w - 24, gy);
    ctx.stroke();
  }

  // Double gold foil border
  ctx.strokeStyle = 'rgba(224, 164, 88, 0.72)';
  ctx.lineWidth = 3;
  ctx.strokeRect(22, 22, w - 44, h - 44);
  ctx.strokeStyle = 'rgba(224, 164, 88, 0.28)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(34, 34, w - 68, h - 68);

  // Top header row
  ctx.fillStyle = '#e0a458';
  ctx.font = '600 32px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(project.rank, 56, 76);

  ctx.fillStyle = '#9ba1ae';
  ctx.font = '500 20px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillText('FullHouse3D Spec Sheet', w - 56, 76);

  // Geometric architectural schematic emblem (clean drafting circles & orthogonal axes)
  const cx = w / 2;
  const cy = 225;
  ctx.strokeStyle = 'rgba(224, 164, 88, 0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 74, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 46, 0, Math.PI * 2);
  ctx.stroke();

  // Isometric architectural frame inside schematic circle
  ctx.strokeStyle = '#e0a458';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 52);
  ctx.lineTo(cx + 46, cy - 22);
  ctx.lineTo(cx + 46, cy + 32);
  ctx.lineTo(cx, cy + 56);
  ctx.lineTo(cx - 46, cy + 32);
  ctx.lineTo(cx - 46, cy - 22);
  ctx.closePath();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx, cy - 52);
  ctx.lineTo(cx, cy + 56);
  ctx.moveTo(cx - 46, cy - 22);
  ctx.lineTo(cx, cy + 4);
  ctx.lineTo(cx + 46, cy - 22);
  ctx.stroke();

  // Crosshair ticks
  ctx.strokeStyle = 'rgba(224, 164, 88, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 115, cy);
  ctx.lineTo(cx - 82, cy);
  ctx.moveTo(cx + 82, cy);
  ctx.lineTo(cx + 115, cy);
  ctx.stroke();

  // Case study title & subtitle
  ctx.fillStyle = '#f4f0e8';
  ctx.font = '500 44px "Cormorant Garamond", Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText(project.title, cx, 356);

  ctx.fillStyle = '#c5c1b8';
  ctx.font = '400 22px "DM Sans", sans-serif';
  ctx.fillText(project.subtitle, cx, 400);

  // Horizontal brass divider
  ctx.strokeStyle = 'rgba(224, 164, 88, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(58, 438);
  ctx.lineTo(w - 58, 438);
  ctx.stroke();

  // Technical spec ledger rows
  const rows = [
    ['Footprint', project.specs.footprint],
    ['Cameras / LODs', project.specs.cameras],
    ['Modular kit', project.specs.library],
    ['Materials', project.specs.materials],
    ['Geometry', project.specs.geometry],
    ['Pipeline', project.specs.formats],
  ];

  let y = 492;
  rows.forEach(([key, val]) => {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#9ba1ae';
    ctx.font = '400 20px "DM Sans", sans-serif';
    ctx.fillText(key, 60, y);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#f4f0e8';
    ctx.font = '500 21px "JetBrains Mono", monospace';
    ctx.fillText(val, w - 60, y);

    ctx.strokeStyle = 'rgba(244, 240, 232, 0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(60, y + 28);
    ctx.lineTo(w - 60, y + 28);
    ctx.stroke();
    y += 66;
  });

  // Footer coordinate bar
  ctx.textAlign = 'left';
  ctx.fillStyle = '#e0a458';
  ctx.font = '500 19px "JetBrains Mono", monospace';
  ctx.fillText('Scale 1:1 m', 60, h - 66);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#9ba1ae';
  ctx.font = '500 19px "JetBrains Mono", monospace';
  ctx.fillText('Click to open case study', w - 60, h - 66);

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

  const rad = ctx.createRadialGradient(size / 2, size / 2, 24, size / 2, size / 2, size * 0.48);
  rad.addColorStop(0, 'rgba(224, 164, 88, 0.09)');
  rad.addColorStop(0.55, 'rgba(24, 28, 36, 0.16)');
  rad.addColorStop(1, 'rgba(9, 11, 15, 0)');
  ctx.fillStyle = rad;
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = 'rgba(224, 164, 88, 0.11)';
  ctx.lineWidth = 1;
  for (let i = 64; i < size; i += 64) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(size, i);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(224, 164, 88, 0.22)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2 + 80, 340, Math.PI * 1.12, Math.PI * 1.88);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function createMoteSpriteTexture() {
  const s = 32;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 1, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(240, 200, 132, 0.85)');
  g.addColorStop(0.45, 'rgba(224, 164, 88, 0.28)');
  g.addColorStop(1, 'rgba(224, 164, 88, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function initCardStage({
  viewportEl,
  canvasEl,
  projects,
  onFocusChange,
  onSelectProject,
  onFlipChange,
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
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x090b0f);
  scene.fog = new THREE.Fog(0x090b0f, 11, 24);

  const camera = new THREE.PerspectiveCamera(34, 16 / 10.6, 0.1, 40);
  camera.position.set(0, 0.42, 8.6);
  camera.lookAt(0, 0.04, 0);

  // Physically balanced studio lighting + dynamic cursor-tracking champagne rim PointLight
  const ambient = new THREE.AmbientLight(0xdbe2ee, 0.72);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xffe4bc, 2.15);
  keyLight.position.set(4.5, 6.2, 6.8);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0xe0a458, 1.75);
  rimLight.position.set(-5.8, 3.6, -2.5);
  scene.add(rimLight);

  const coolFill = new THREE.DirectionalLight(0x88a2c8, 0.8);
  coolFill.position.set(-4.2, -1.5, 5.2);
  scene.add(coolFill);

  const cursorRimLight = new THREE.PointLight(0xf2bc74, 4.2, 9.5, 1.6);
  cursorRimLight.position.set(0, 1.2, 3.4);
  scene.add(cursorRimLight);

  // Subtle architectural drafting floor
  const floorGeo = new THREE.PlaneGeometry(16, 12);
  const floorMat = new THREE.MeshStandardMaterial({
    map: createDraftingFloorTexture(),
    roughness: 0.7,
    metalness: 0.22,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -1.72, -0.4);
  scene.add(floor);

  // Restrained deep-space warm gold dust motes
  const moteCount = 44;
  const motePositions = new Float32Array(moteCount * 3);
  const moteBase = [];
  for (let i = 0; i < moteCount; i++) {
    const mx = (Math.random() - 0.5) * 11;
    const my = (Math.random() - 0.5) * 4.8 + 0.3;
    const mz = -1.8 - Math.random() * 4.5;
    motePositions[i * 3] = mx;
    motePositions[i * 3 + 1] = my;
    motePositions[i * 3 + 2] = mz;
    moteBase.push({ x: mx, y: my, z: mz, phase: Math.random() * Math.PI * 2, speed: 0.25 + Math.random() * 0.35 });
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePositions, 3));
  const moteMat = new THREE.PointsMaterial({
    map: createMoteSpriteTexture(),
    size: 0.11,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  scene.add(motes);

  // Shared sculpted double-sided card geometries
  const cardW = 1.64;
  const cardH = 2.3;
  const cardRadius = 0.1;
  const slabShape = createRoundedCardShape(cardW, cardH, cardRadius);
  const slabGeo = new THREE.ExtrudeGeometry(slabShape, {
    depth: 0.028,
    bevelEnabled: true,
    bevelThickness: 0.015,
    bevelSize: 0.015,
    bevelSegments: 3,
    curveSegments: 16,
  });
  slabGeo.center();

  const faceGeo = createRoundedFaceGeometry(cardW - 0.012, cardH - 0.012, cardRadius * 0.92);

  const goldBevelMat = new THREE.MeshStandardMaterial({
    color: 0xe0a458,
    metalness: 0.9,
    roughness: 0.22,
  });

  const rig = new THREE.Group();
  rig.position.set(0, 0.04, 0);
  scene.add(rig);

  // State variables declared strictly before updateSize() / renderOnce()
  const raycaster = new THREE.Raycaster();
  const pointerNDC = new THREE.Vector2(99, 99);
  const pointerTarget = { x: 0, y: 0 };
  const pointerCurrent = { x: 0, y: 0 };
  let isPointerInside = false;
  let isDragging = false;
  let dragStartX = 0;
  let dragDistance = 0;
  let dragOffsetTarget = 0;
  let dragOffsetCurrent = 0;
  let rafId = 0;
  let elapsed = 0;
  let lastTime = performance.now();

  const count = projects.length;
  const cardEntries = [];
  const pickMeshes = [];
  let hoveredIndex = -1;
  let focusedIndex = 0;
  let flippedIndex = -1;

  projects.forEach((project, idx) => {
    const t = count > 1 ? idx / (count - 1) - 0.5 : 0;
    const baseX = t * 5.75;
    const baseY = -t * t * 1.45 + 0.16;
    const baseZ = idx * 0.11 - 0.28;
    const baseRotZ = -t * 0.34;
    const baseRotY = -t * 0.16;

    const cardGroup = new THREE.Group();
    cardGroup.position.set(baseX, baseY, baseZ);
    cardGroup.rotation.set(0, baseRotY, baseRotZ);

    // Metallic gold beveled core
    const slabMesh = new THREE.Mesh(slabGeo, goldBevelMat);
    slabMesh.userData = { index: idx, project };
    cardGroup.add(slabMesh);
    pickMeshes.push(slabMesh);

    // Front architectural render face
    const frontTex = new THREE.CanvasTexture(drawCardFrontCanvas(project, null));
    frontTex.colorSpace = THREE.SRGBColorSpace;
    frontTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const frontMat = new THREE.MeshStandardMaterial({
      map: frontTex,
      roughness: 0.32,
      metalness: 0.14,
    });
    const frontMesh = new THREE.Mesh(faceGeo, frontMat);
    frontMesh.position.z = 0.031;
    frontMesh.userData = { index: idx, project };
    cardGroup.add(frontMesh);
    pickMeshes.push(frontMesh);

    // Back gold-foil blueprint specification face
    const backTex = new THREE.CanvasTexture(drawCardBackCanvas(project));
    backTex.colorSpace = THREE.SRGBColorSpace;
    backTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const backMat = new THREE.MeshStandardMaterial({
      map: backTex,
      roughness: 0.36,
      metalness: 0.24,
    });
    const backMesh = new THREE.Mesh(faceGeo, backMat);
    backMesh.position.z = -0.031;
    backMesh.rotation.y = Math.PI;
    backMesh.userData = { index: idx, project };
    cardGroup.add(backMesh);
    pickMeshes.push(backMesh);

    rig.add(cardGroup);

    cardEntries.push({
      group: cardGroup,
      frontTex,
      project,
      baseX,
      baseY,
      baseZ,
      baseRotZ,
      baseRotY,
      lift: 0,
      flipAngle: 0,
    });

    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      frontTex.image = drawCardFrontCanvas(project, img);
      frontTex.needsUpdate = true;
      renderOnce();
    };
    img.src = project.cardImage;
  });

  function setFocus(index) {
    const clamped = Math.max(0, Math.min(count - 1, index));
    if (clamped !== focusedIndex) {
      focusedIndex = clamped;
      if (flippedIndex !== -1 && flippedIndex !== focusedIndex) {
        flippedIndex = -1;
        if (onFlipChange) onFlipChange(false);
      }
      if (onFocusChange) onFocusChange(projects[focusedIndex], focusedIndex);
    }
  }

  function toggleFlip(index = focusedIndex) {
    const targetIdx = index >= 0 ? index : 0;
    if (targetIdx !== focusedIndex) {
      setFocus(targetIdx);
    }
    flippedIndex = flippedIndex === focusedIndex ? -1 : focusedIndex;
    if (onFlipChange) onFlipChange(flippedIndex === focusedIndex);
    if (isPaused) {
      for (let k = 0; k < 24; k++) step(0.05);
    }
  }

  function updateSize() {
    const rect = viewportEl.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.aspect = aspect;

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
    const hits = raycaster.intersectObjects(pickMeshes, false);
    if (hits.length > 0) {
      return hits[0].object.userData.index;
    }
    return -1;
  }

  canvasEl.addEventListener('pointerdown', (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragDistance = 0;
    canvasEl.dataset.dragging = 'true';
    try {
      canvasEl.setPointerCapture(e.pointerId);
    } catch {}
  });

  canvasEl.addEventListener('pointermove', (e) => {
    isPointerInside = true;
    updatePointer(e.clientX, e.clientY);

    if (isDragging) {
      const dx = e.clientX - dragStartX;
      dragDistance = Math.max(dragDistance, Math.abs(dx));
      dragOffsetTarget = THREE.MathUtils.clamp(dx / 180, -1.2, 1.2);
      if (Math.abs(dx) > 54) {
        const stepDir = dx > 0 ? -1 : 1;
        setFocus(focusedIndex + stepDir);
        dragStartX = e.clientX;
        dragOffsetTarget = 0;
      }
      if (isPaused) renderOnce();
      return;
    }

    const hit = pickCard();
    if (hit !== hoveredIndex) {
      hoveredIndex = hit;
      canvasEl.dataset.hover = hit >= 0 ? 'card' : '';
      if (hit >= 0) {
        setFocus(hit);
      }
    }
    if (isPaused) renderOnce();
  });

  function endDrag() {
    if (!isDragging) return;
    isDragging = false;
    dragOffsetTarget = 0;
    canvasEl.dataset.dragging = '';
  }

  canvasEl.addEventListener('pointerup', (e) => {
    const wasClick = dragDistance < 7;
    endDrag();
    if (wasClick) {
      isPointerInside = true;
      updatePointer(e.clientX, e.clientY);
      const hit = pickCard();
      if (hit >= 0 && onSelectProject) {
        setFocus(hit);
        onSelectProject(projects[hit]);
      }
    }
  });

  canvasEl.addEventListener('dblclick', (e) => {
    isPointerInside = true;
    updatePointer(e.clientX, e.clientY);
    const hit = pickCard();
    if (hit >= 0) {
      toggleFlip(hit);
    }
  });

  canvasEl.addEventListener('pointercancel', endDrag);

  canvasEl.addEventListener('pointerleave', () => {
    endDrag();
    isPointerInside = false;
    hoveredIndex = -1;
    canvasEl.dataset.hover = '';
    pointerTarget.x = 0;
    pointerTarget.y = 0;
    if (isPaused) renderOnce();
  });

  const ro = new ResizeObserver(() => updateSize());
  ro.observe(viewportEl);
  updateSize();

  function step(dt) {
    if (!isPaused) {
      elapsed += dt;
    }

    pointerCurrent.x += (pointerTarget.x - pointerCurrent.x) * Math.min(1, dt * 6.5);
    pointerCurrent.y += (pointerTarget.y - pointerCurrent.y) * Math.min(1, dt * 6.5);
    dragOffsetCurrent += (dragOffsetTarget - dragOffsetCurrent) * Math.min(1, dt * 10);

    // Dynamic cursor-tracking warm champagne specular rim light
    cursorRimLight.position.x = pointerCurrent.x * 4.2;
    cursorRimLight.position.y = 0.8 + pointerCurrent.y * 2.4;
    cursorRimLight.position.z = 3.2;

    const idleYaw = isPaused ? 0 : Math.sin(elapsed * 0.42) * 0.05;
    const idlePitch = isPaused ? 0 : Math.cos(elapsed * 0.34) * 0.022;

    rig.rotation.y = pointerCurrent.x * 0.14 + dragOffsetCurrent * 0.18 + idleYaw;
    rig.rotation.x = -pointerCurrent.y * 0.06 + idlePitch;

    const activeIdx = hoveredIndex >= 0 ? hoveredIndex : focusedIndex;

    for (let i = 0; i < cardEntries.length; i++) {
      const c = cardEntries[i];
      const isActive = i === activeIdx;
      const isFlipped = i === flippedIndex;
      const targetLift = isFlipped ? 1.35 : isActive ? 0.95 : 0;
      const targetFlip = isFlipped ? Math.PI : 0;

      c.lift += (targetLift - c.lift) * Math.min(1, dt * 9);
      c.flipAngle += (targetFlip - c.flipAngle) * Math.min(1, dt * 7.5);

      const floatY = isPaused ? 0 : Math.sin(elapsed * 0.85 + i * 0.85) * 0.032;
      const centerPull = isFlipped ? -c.baseX * 0.45 : 0;

      c.group.position.x = c.baseX + centerPull + dragOffsetCurrent * 0.35;
      c.group.position.y = c.baseY + floatY + c.lift * 0.34;
      c.group.position.z = c.baseZ + c.lift * 1.15;
      c.group.rotation.z = c.baseRotZ * (1 - Math.min(1, c.lift) * 0.85);
      c.group.rotation.y = c.baseRotY * (1 - Math.min(1, c.lift) * 0.85) + c.flipAngle;
    }

    // Gentle deep-space mote drift
    if (!isPaused) {
      const posAttr = moteGeo.attributes.position;
      for (let i = 0; i < moteCount; i++) {
        const b = moteBase[i];
        posAttr.setY(i, b.y + Math.sin(elapsed * b.speed + b.phase) * 0.18);
        posAttr.setX(i, b.x + Math.cos(elapsed * b.speed * 0.6 + b.phase) * 0.12);
      }
      posAttr.needsUpdate = true;
    }

    renderer.render(scene, camera);
  }

  function renderOnce() {
    step(0.016);
  }

  let isVisible = true;

  function loop(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    step(dt);
    if (!isPaused && isVisible) {
      rafId = requestAnimationFrame(loop);
    } else {
      rafId = 0;
    }
  }

  if (typeof IntersectionObserver !== 'undefined') {
    const io = new IntersectionObserver(
      (entries) => {
        isVisible = Boolean(entries[0]?.isIntersecting);
        if (isVisible && !isPaused && !rafId) {
          lastTime = performance.now();
          rafId = requestAnimationFrame(loop);
        } else if (!isVisible && rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
      },
      { threshold: 0.05 }
    );
    io.observe(viewportEl);
  }

  viewportEl.dataset.webgl = 'ready';
  renderOnce();
  if (!isPaused) {
    rafId = requestAnimationFrame(loop);
  }

  return {
    focusCard(index) {
      setFocus(index);
      hoveredIndex = -1;
      if (isPaused) {
        for (let k = 0; k < 20; k++) step(0.05);
      }
    },
    toggleFlip() {
      toggleFlip(focusedIndex);
      return flippedIndex === focusedIndex;
    },
    isFlipped() {
      return flippedIndex === focusedIndex;
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
