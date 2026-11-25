import { PROJECTS } from './data.js';
import { initCardStage } from './stage3d.js';

const projectMap = new Map(PROJECTS.map((p) => [p.id, p]));

function setupMobileMenu() {
  const toggleBtn = document.getElementById('menu-toggle');
  const mobileMenu = document.getElementById('mobile-menu');
  if (!toggleBtn || !mobileMenu) return;

  function setMenuOpen(open) {
    toggleBtn.setAttribute('aria-expanded', String(open));
    mobileMenu.dataset.open = String(open);
    mobileMenu.hidden = !open;
  }

  toggleBtn.addEventListener('click', () => {
    const currentlyOpen = toggleBtn.getAttribute('aria-expanded') === 'true';
    setMenuOpen(!currentlyOpen);
  });

  mobileMenu.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => setMenuOpen(false));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && toggleBtn.getAttribute('aria-expanded') === 'true') {
      setMenuOpen(false);
      toggleBtn.focus();
    }
  });
}

function setupModal() {
  const dialog = document.getElementById('project-modal');
  if (!dialog) return { openProject: () => {} };

  const titleEl = document.getElementById('modal-title');
  const subtitleEl = document.getElementById('modal-subtitle');
  const stageEl = document.getElementById('modal-stage');
  const thumbsEl = document.getElementById('modal-thumbs');
  const videoToggleBtn = document.getElementById('modal-video-toggle');
  const summaryEl = document.getElementById('modal-summary');
  const specsEl = document.getElementById('modal-specs');
  const highlightsEl = document.getElementById('modal-highlights');
  const gumroadBtn = document.getElementById('modal-buy-gumroad');
  const itchBtn = document.getElementById('modal-buy-itch');
  const cgtraderLink = document.getElementById('modal-buy-cgtrader');
  const closeBtn = document.getElementById('modal-close');

  let activeProject = null;
  let showingVideo = false;
  let lastTriggerEl = null;

  function clearMediaStage() {
    const oldVideo = stageEl.querySelector('video');
    if (oldVideo) {
      oldVideo.pause();
      oldVideo.removeAttribute('src');
      oldVideo.load();
    }
    stageEl.textContent = '';
  }

  function showGalleryImage(index) {
    if (!activeProject) return;
    showingVideo = false;
    updateVideoButton();
    clearMediaStage();

    const item = activeProject.gallery[index] || activeProject.gallery[0];
    const img = document.createElement('img');
    img.src = item.src;
    img.alt = item.alt;
    img.decoding = 'async';
    stageEl.appendChild(img);

    thumbsEl.querySelectorAll('.thumb-btn').forEach((btn, i) => {
      btn.setAttribute('aria-pressed', String(i === index));
    });
  }

  function showTourVideo() {
    if (!activeProject || !activeProject.video) return;
    showingVideo = true;
    updateVideoButton();
    clearMediaStage();

    const video = document.createElement('video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.poster = activeProject.coverImage;
    video.src = activeProject.video;
    stageEl.appendChild(video);
    video.play().catch(() => {});

    thumbsEl.querySelectorAll('.thumb-btn').forEach((btn) => {
      btn.setAttribute('aria-pressed', 'false');
    });
  }

  function updateVideoButton() {
    if (!activeProject || !activeProject.video) {
      videoToggleBtn.hidden = true;
      return;
    }
    videoToggleBtn.hidden = false;
    videoToggleBtn.textContent = showingVideo ? 'Back to gallery' : 'Play tour video';
  }

  function openProject(projectId, triggerEl) {
    const project = typeof projectId === 'string' ? projectMap.get(projectId) : projectId;
    if (!project) return;

    activeProject = project;
    lastTriggerEl = triggerEl || document.activeElement;
    showingVideo = false;

    titleEl.textContent = project.title;
    subtitleEl.textContent = project.subtitle;
    summaryEl.textContent = project.summary;

    // Spec cells
    specsEl.textContent = '';
    const specEntries = [
      ['Footprint', project.specs.footprint],
      ['Cameras / LODs', project.specs.cameras],
      ['Asset library', project.specs.library],
      ['Materials', project.specs.materials],
      ['Formats', project.specs.formats],
      ['Geometry', project.specs.geometry],
    ];
    specEntries.forEach(([k, v]) => {
      const cell = document.createElement('div');
      cell.className = 'spec-cell';
      const kEl = document.createElement('span');
      kEl.className = 'spec-key';
      kEl.textContent = k;
      const vEl = document.createElement('span');
      vEl.className = 'spec-val';
      vEl.textContent = v;
      cell.append(kEl, vEl);
      specsEl.appendChild(cell);
    });

    // Highlights
    highlightsEl.textContent = '';
    project.highlights.forEach((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      highlightsEl.appendChild(li);
    });

    // Thumbnails (lazy-loaded only when modal opens)
    thumbsEl.textContent = '';
    project.gallery.forEach((item, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'thumb-btn';
      btn.setAttribute('aria-label', `Show render ${idx + 1}: ${item.alt}`);
      btn.setAttribute('aria-pressed', String(idx === 0));
      const img = document.createElement('img');
      img.src = item.src;
      img.alt = '';
      img.loading = 'lazy';
      btn.appendChild(img);
      btn.addEventListener('click', () => showGalleryImage(idx));
      thumbsEl.appendChild(btn);
    });

    gumroadBtn.href = project.gumroadUrl;
    gumroadBtn.textContent = `Buy on Gumroad (${project.gumroadPrice})`;

    itchBtn.href = project.itchUrl;
    itchBtn.textContent = `Buy on Itch.io (${project.itchPrice})`;

    cgtraderLink.href = project.cgtraderUrl;
    cgtraderLink.textContent =
      project.cgtraderPrice === 'Storefront'
        ? 'Browse CGTrader storefront'
        : `Buy on CGTrader (${project.cgtraderPrice})`;

    showGalleryImage(0);

    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    closeBtn.focus();
  }

  function closeModal() {
    clearMediaStage();
    if (typeof dialog.close === 'function' && dialog.open) {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
    if (lastTriggerEl && typeof lastTriggerEl.focus === 'function') {
      lastTriggerEl.focus();
    }
  }

  videoToggleBtn.addEventListener('click', () => {
    if (showingVideo) {
      showGalleryImage(0);
    } else {
      showTourVideo();
    }
  });

  closeBtn.addEventListener('click', closeModal);

  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) closeModal();
  });

  dialog.addEventListener('close', () => {
    clearMediaStage();
  });

  // Wire all inspect buttons across catalog & spec table
  document.querySelectorAll('[data-inspect]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openProject(btn.dataset.inspect, btn);
    });
  });

  return { openProject };
}

function setupHeroStage(openProject) {
  const viewportEl = document.getElementById('card-stage-viewport');
  const canvasEl = document.getElementById('card-stage-canvas');
  const activeNameEl = document.getElementById('stage-active-name');
  const activeMetaEl = document.getElementById('stage-active-meta');
  const inspectActiveBtn = document.getElementById('stage-inspect-active');
  const pauseBtn = document.getElementById('stage-pause-btn');
  const chips = Array.from(document.querySelectorAll('[data-card-index]'));

  let currentProject = PROJECTS[0];

  function updateReadout(project, index) {
    currentProject = project;
    if (activeNameEl) activeNameEl.textContent = project.title;
    if (activeMetaEl) activeMetaEl.textContent = `${project.gumroadPrice} on Gumroad`;
    chips.forEach((chip, i) => {
      chip.setAttribute('aria-pressed', String(i === index));
    });
  }

  const stage = initCardStage({
    viewportEl,
    canvasEl,
    projects: PROJECTS,
    onFocusChange: updateReadout,
    onSelectProject: (project) => openProject(project, canvasEl),
  });

  chips.forEach((chip) => {
    const idx = Number(chip.dataset.cardIndex);
    chip.addEventListener('click', () => {
      if (stage) {
        stage.focusCard(idx);
      } else {
        updateReadout(PROJECTS[idx], idx);
      }
    });
    chip.addEventListener('dblclick', () => openProject(PROJECTS[idx], chip));
  });

  if (inspectActiveBtn) {
    inspectActiveBtn.addEventListener('click', () => {
      openProject(currentProject, inspectActiveBtn);
    });
  }

  if (pauseBtn && stage) {
    const syncPauseLabel = () => {
      const paused = stage.isPaused();
      pauseBtn.setAttribute('aria-pressed', String(paused));
      pauseBtn.textContent = paused ? 'Resume motion' : 'Pause motion';
    };
    syncPauseLabel();
    pauseBtn.addEventListener('click', () => {
      stage.setPaused(!stage.isPaused());
      syncPauseLabel();
    });
  } else if (pauseBtn) {
    pauseBtn.hidden = true;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setupMobileMenu();
  const { openProject } = setupModal();
  setupHeroStage(openProject);
});
