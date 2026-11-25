import { LIGHTING_COMPARISONS, PROJECTS, STUDIO_CONTACT } from './data.js';
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

function setupLightingCurtain() {
  const stage = document.getElementById('lighting-curtain');
  const dayImg = document.getElementById('curtain-day-img');
  const duskImg = document.getElementById('curtain-dusk-img');
  const viewLabelEl = document.getElementById('curtain-view-label');
  const pctEl = document.getElementById('curtain-pct');
  const tabs = Array.from(document.querySelectorAll('[data-lighting-index]'));
  if (!stage || !dayImg || !duskImg) return;

  let splitPct = 50;
  let dragging = false;

  function applySplit(pct) {
    splitPct = Math.max(4, Math.min(96, Math.round(pct * 10) / 10));
    const rect = stage.getBoundingClientRect();
    const px = (splitPct / 100) * rect.width;
    stage.style.setProperty('--split', `${splitPct}%`);
    stage.style.setProperty('--curtain-px', `${px}px`);
    stage.setAttribute('aria-valuenow', String(Math.round(splitPct)));
    if (pctEl) {
      pctEl.textContent = `${Math.round(splitPct)}% daylight / ${100 - Math.round(splitPct)}% blue hour`;
    }
  }

  function updateFromClientX(clientX) {
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    applySplit(pct);
  }

  function selectScene(index) {
    const item = LIGHTING_COMPARISONS[index] || LIGHTING_COMPARISONS[0];
    dayImg.src = item.dayImage;
    dayImg.alt = `${item.title} daylight Cycles render`;
    duskImg.src = item.duskImage;
    duskImg.alt = `${item.title} blue-hour Cycles render`;
    if (viewLabelEl) {
      viewLabelEl.textContent = `${item.title}: ${item.viewLabel}`;
    }
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
    });
  }

  stage.addEventListener('pointerdown', (e) => {
    dragging = true;
    updateFromClientX(e.clientX);
    try {
      stage.setPointerCapture(e.pointerId);
    } catch {}
  });

  stage.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    updateFromClientX(e.clientX);
  });

  const stopDrag = () => {
    dragging = false;
  };
  stage.addEventListener('pointerup', stopDrag);
  stage.addEventListener('pointercancel', stopDrag);

  stage.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      applySplit(splitPct - 5);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      applySplit(splitPct + 5);
    } else if (e.key === 'Home') {
      e.preventDefault();
      applySplit(10);
    } else if (e.key === 'End') {
      e.preventDefault();
      applySplit(90);
    }
  });

  tabs.forEach((tab) => {
    const idx = Number(tab.dataset.lightingIndex);
    tab.addEventListener('click', () => selectScene(idx));
  });

  const ro = new ResizeObserver(() => applySplit(splitPct));
  ro.observe(stage);

  selectScene(0);
  applySplit(50);
}

function setupPortfolioFilter() {
  const stack = document.getElementById('works-stack');
  const filterBtns = Array.from(document.querySelectorAll('[data-filter]'));
  const serviceTriggers = Array.from(document.querySelectorAll('[data-service-filter]'));
  const items = Array.from(document.querySelectorAll('[data-categories]'));
  if (!stack || !items.length) return;

  function applyFilter(filterKey) {
    const isAll = filterKey === 'all';
    stack.dataset.filtered = String(!isAll);

    items.forEach((el) => {
      const cats = (el.dataset.categories || '').split(/\s+/);
      const visible = isAll || cats.includes(filterKey);
      el.hidden = !visible;
    });

    filterBtns.forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.filter === filterKey));
    });
  }

  filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => applyFilter(btn.dataset.filter));
  });

  serviceTriggers.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.serviceFilter;
      if (target === 'walkthrough') {
        document.getElementById('walkthrough')?.scrollIntoView({ behavior: 'smooth' });
        return;
      }
      applyFilter(target);
      document.getElementById('works')?.scrollIntoView({ behavior: 'smooth' });
    });
  });

  applyFilter('all');
}

function setupBriefBuilder() {
  const disciplineChips = Array.from(document.querySelectorAll('[data-brief-discipline]'));
  const deliverableChips = Array.from(document.querySelectorAll('[data-brief-deliverable]'));
  const timelineChips = Array.from(document.querySelectorAll('[data-brief-timeline]'));
  const nameInput = document.getElementById('brief-name');
  const notesInput = document.getElementById('brief-notes');
  const previewEl = document.getElementById('brief-preview');
  const whatsappBtn = document.getElementById('brief-whatsapp-btn');
  const emailBtn = document.getElementById('brief-email-btn');
  const copyBtn = document.getElementById('brief-copy-btn');
  const copyStatusEl = document.getElementById('brief-copy-status');
  const directEmailLink = document.getElementById('direct-email-link');
  const directWhatsappLink = document.getElementById('direct-whatsapp-link');

  if (!previewEl) return { prefillFromProject: () => {} };

  const state = {
    discipline: 'Architectural visualization',
    deliverable: 'Stills and video tour',
    timeline: '2 to 4 weeks',
    reference: '',
    sender: '',
    notes: '',
  };

  if (directEmailLink) {
    directEmailLink.href = `mailto:${STUDIO_CONTACT.email}`;
    directEmailLink.textContent = STUDIO_CONTACT.email;
  }

  if (directWhatsappLink) {
    if (STUDIO_CONTACT.whatsappNumber) {
      directWhatsappLink.href = `https://wa.me/${STUDIO_CONTACT.whatsappNumber}`;
      directWhatsappLink.textContent = STUDIO_CONTACT.whatsappDisplay || `+${STUDIO_CONTACT.whatsappNumber}`;
    } else {
      directWhatsappLink.hidden = true;
    }
  }

  function buildBriefText() {
    const lines = [
      `Hello ${STUDIO_CONTACT.lead} (${STUDIO_CONTACT.studioName}),`,
      '',
      'I would like to discuss a custom 3D project:',
      `Discipline: ${state.discipline}`,
      `Deliverable: ${state.deliverable}`,
      `Target timeline: ${state.timeline}`,
    ];
    if (state.reference) {
      lines.push(`Reference study: ${state.reference}`);
    }
    if (state.sender.trim()) {
      lines.push(`Client / Studio: ${state.sender.trim()}`);
    }
    if (state.notes.trim()) {
      lines.push(`Project notes: ${state.notes.trim()}`);
    }
    lines.push('', 'Looking forward to scope and schedule details.');
    return lines.join('\n');
  }

  function syncOutputs() {
    const text = buildBriefText();
    previewEl.textContent = text;

    const subject = `3D Project Inquiry - ${state.discipline}`;
    if (emailBtn) {
      emailBtn.href = `mailto:${STUDIO_CONTACT.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
    }

    if (whatsappBtn) {
      if (STUDIO_CONTACT.whatsappNumber) {
        whatsappBtn.hidden = false;
        whatsappBtn.href = `https://wa.me/${STUDIO_CONTACT.whatsappNumber}?text=${encodeURIComponent(text)}`;
      } else {
        whatsappBtn.hidden = true;
      }
    }
  }

  function wireRadioChips(chips, attr, stateKey) {
    chips.forEach((chip) => {
      chip.addEventListener('click', () => {
        state[stateKey] = chip.getAttribute(attr);
        chips.forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
        syncOutputs();
      });
    });
  }

  wireRadioChips(disciplineChips, 'data-brief-discipline', 'discipline');
  wireRadioChips(deliverableChips, 'data-brief-deliverable', 'deliverable');
  wireRadioChips(timelineChips, 'data-brief-timeline', 'timeline');

  if (nameInput) {
    nameInput.addEventListener('input', () => {
      state.sender = nameInput.value;
      syncOutputs();
    });
  }

  if (notesInput) {
    notesInput.addEventListener('input', () => {
      state.notes = notesInput.value;
      syncOutputs();
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = buildBriefText();
      try {
        await navigator.clipboard.writeText(text);
        if (copyStatusEl) copyStatusEl.textContent = 'Brief copied to clipboard';
      } catch {
        if (copyStatusEl) copyStatusEl.textContent = 'Select and copy the brief text above';
      }
      window.setTimeout(() => {
        if (copyStatusEl) copyStatusEl.textContent = '';
      }, 3000);
    });
  }

  function prefillFromProject(project) {
    if (!project) return;
    state.reference = `${project.title} (${project.specs.footprint})`;
    const targetDiscipline =
      project.discipline === 'environment'
        ? '3D environment or biome'
        : 'Architectural visualization';
    state.discipline = targetDiscipline;
    disciplineChips.forEach((c) => {
      c.setAttribute('aria-pressed', String(c.getAttribute('data-brief-discipline') === targetDiscipline));
    });
    if (notesInput && !notesInput.value.trim()) {
      notesInput.value = `Interested in a custom project at the scale and quality bar of ${project.title}.`;
      state.notes = notesInput.value;
    }
    syncOutputs();
    document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' });
  }

  // Wire direct "Request similar work" buttons on case study rows
  document.querySelectorAll('[data-inquire-project]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = projectMap.get(btn.dataset.inquireProject);
      if (p) prefillFromProject(p);
    });
  });

  syncOutputs();
  return { prefillFromProject };
}

function setupModal(prefillFromProject) {
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
  const inquireBtn = document.getElementById('modal-inquire-btn');
  const whatsappQuickBtn = document.getElementById('modal-whatsapp-btn');
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

    highlightsEl.textContent = '';
    project.highlights.forEach((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      highlightsEl.appendChild(li);
    });

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

    if (whatsappQuickBtn) {
      if (STUDIO_CONTACT.whatsappNumber) {
        whatsappQuickBtn.hidden = false;
        const msg = `Hello ${STUDIO_CONTACT.lead} (${STUDIO_CONTACT.studioName}), I saw the ${project.title} case study and would like to discuss a custom 3D project.`;
        whatsappQuickBtn.href = `https://wa.me/${STUDIO_CONTACT.whatsappNumber}?text=${encodeURIComponent(msg)}`;
      } else {
        whatsappQuickBtn.hidden = true;
      }
    }

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

  if (inquireBtn) {
    inquireBtn.addEventListener('click', () => {
      const proj = activeProject;
      closeModal();
      if (proj && prefillFromProject) {
        prefillFromProject(proj);
      }
    });
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
  const flipBtn = document.getElementById('stage-flip-btn');
  const inspectActiveBtn = document.getElementById('stage-inspect-active');
  const pauseBtn = document.getElementById('stage-pause-btn');
  const chips = Array.from(document.querySelectorAll('[data-card-index]'));

  let currentProject = PROJECTS[0];

  function updateReadout(project, index) {
    currentProject = project;
    if (activeNameEl) activeNameEl.textContent = project.title;
    if (activeMetaEl) activeMetaEl.textContent = `${project.scaleBadge}, ${project.specs.cameras}`;
    chips.forEach((chip, i) => {
      chip.setAttribute('aria-pressed', String(i === index));
    });
  }

  function syncFlipLabel(flipped) {
    if (!flipBtn) return;
    flipBtn.setAttribute('aria-pressed', String(flipped));
    flipBtn.textContent = flipped ? 'Show front' : 'Flip for specs';
  }

  const stage = initCardStage({
    viewportEl,
    canvasEl,
    projects: PROJECTS,
    onFocusChange: updateReadout,
    onSelectProject: (project) => openProject(project, canvasEl),
    onFlipChange: syncFlipLabel,
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
  });

  if (flipBtn && stage) {
    flipBtn.addEventListener('click', () => {
      const flipped = stage.toggleFlip();
      syncFlipLabel(flipped);
    });
  } else if (flipBtn) {
    flipBtn.hidden = true;
  }

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
  setupLightingCurtain();
  setupPortfolioFilter();
  const { prefillFromProject } = setupBriefBuilder();
  const { openProject } = setupModal(prefillFromProject);
  setupHeroStage(openProject);
});
