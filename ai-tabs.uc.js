// ==UserScript==
// @ignorecache
// @name          Zen AI Tabs
// @description   Sorts tabs using either Firefox Local AI or Google Gemini
// ==/UserScript==

(() => {
  // --- PREFERENCES ---
  const PREFS = {
    PROVIDER: "extensions.zen-ai-tabs.ai_provider",
    GEMINI_KEY: "extensions.zen-ai-tabs.gemini_api_key",
    GEMINI_MODEL: "extensions.zen-ai-tabs.gemini_model",
    // UI Prefs
    SHOW_LABELS: "extensions.zen-ai-tabs.show_labels",
    UI_SCALE: "extensions.zen-ai-tabs.ui_scale",
    LINE_GAP: "extensions.zen-ai-tabs.line_gap",
  };

  const getPref = (prefName, type, fallback) => {
    try {
      const branch = Services.prefs.getBranch("");
      if (branch.prefHasUserValue(prefName)) {
        if (type === "int") return branch.getIntPref(prefName);
        if (type === "string") return branch.getStringPref(prefName);
        if (type === "bool") return branch.getBoolPref(prefName);
      }
    } catch (e) {}
    return fallback;
  };

  // --- STYLE APPLICATOR ---
  const applyUserStyles = () => {
    const showLabels = getPref(PREFS.SHOW_LABELS, "bool", true);
    const scale = getPref(PREFS.UI_SCALE, "int", 1); // Default Normal
    const gap = getPref(PREFS.LINE_GAP, "int", 40); // Default Small Gap

    const root = document.documentElement;

    // 1. Label Display (Flex or None)
    root.style.setProperty(
      "--zen-ai-label-display",
      showLabels ? "block" : "none",
    );

    // 2. Line Gap
    root.style.setProperty("--zen-ai-separator-gap", `${gap}px`);

    // 3. Sizes
    let iconSize = 16,
      fontSize = 11,
      btnPadding = "2px 6px";

    if (scale === 0) {
      // Compact
      iconSize = 14;
      fontSize = 10;
      btnPadding = "1px 4px";
    } else if (scale === 2) {
      // Large
      iconSize = 20;
      fontSize = 13;
      btnPadding = "4px 8px";
    }

    root.style.setProperty("--zen-ai-icon-size", `${iconSize}px`);
    root.style.setProperty("--zen-ai-font-size", `${fontSize}px`);
    root.style.setProperty("--zen-ai-btn-padding", btnPadding);
  };

  // --- PREF OBSERVER (Live Updates) ---
  const prefObserver = {
    observe(subject, topic, data) {
      if (data.startsWith("extensions.zen-ai-tabs")) {
        applyUserStyles();
      }
    },
  };
  Services.prefs.addObserver("extensions.zen-ai-tabs", prefObserver);
  window.addEventListener("unload", () =>
    Services.prefs.removeObserver("extensions.zen-ai-tabs", prefObserver),
  );

  const CONFIG = {
    SIMILARITY_THRESHOLD: 0.45,
    GROUP_SIMILARITY_THRESHOLD: 0.65,
    MIN_TABS_FOR_SORT: 1,
    DEBOUNCE_DELAY: 250,
    ANIMATION_DURATION: 800,
    MAX_INIT_CHECKS: 50,
    INIT_CHECK_INTERVAL: 100,
    CONSOLIDATION_DISTANCE_THRESHOLD: 2,
    EMBEDDING_BATCH_SIZE: 5,
    EXISTING_GROUP_BOOST: 0.1,
  };

  // --- Globals & State ---
  let isSorting = false;
  let isPlayingFailureAnimation = false;
  let sortAnimationId = null;

  // DOM Cache
  const domCache = {
    separators: null,
    commandSet: null,
    getSeparators() {
      if (!this.separators || !this.separators.length) {
        this.separators = document.querySelectorAll(
          ".pinned-tabs-container-separator",
        );
      }
      return this.separators;
    },
    getCommandSet() {
      if (!this.commandSet) {
        this.commandSet = document.querySelector("commandset#zenCommandSet");
      }
      return this.commandSet;
    },
    invalidate() {
      this.separators = null;
      this.commandSet = null;
    },
  };

  // --- Helper Functions ---
  const getFilteredTabs = (workspaceId, options = {}) => {
    if (!workspaceId || typeof gBrowser === "undefined" || !gBrowser.tabs) {
      return [];
    }
    const {
      includeGrouped = false,
      includeSelected = true,
      includePinned = false,
      includeEmpty = false,
      includeGlance = false,
    } = options;

    return Array.from(gBrowser.tabs).filter((tab) => {
      if (!tab?.isConnected) return false;
      const isInCorrectWorkspace =
        tab.getAttribute("zen-workspace-id") === workspaceId;
      if (!isInCorrectWorkspace) return false;
      const groupParent = tab.closest("tab-group");
      const isInGroup = !!groupParent;

      return (
        (includePinned || !tab.pinned) &&
        (includeGrouped || !isInGroup) &&
        (includeSelected || !tab.selected) &&
        (includeEmpty || !tab.hasAttribute("zen-empty-tab")) &&
        (includeGlance || !tab.hasAttribute("zen-glance-tab"))
      );
    });
  };

  const getTabTitle = (tab) => {
    if (!tab?.isConnected) return "Invalid Tab";
    try {
      const originalTitle =
        tab.getAttribute("label") ||
        tab.querySelector(".tab-label, .tab-text")?.textContent ||
        "";

      if (
        !originalTitle ||
        originalTitle === "New Tab" ||
        originalTitle === "about:blank" ||
        originalTitle.startsWith("http")
      ) {
        const browser =
          tab.linkedBrowser ||
          tab._linkedBrowser ||
          gBrowser?.getBrowserForTab?.(tab);
        if (
          browser?.currentURI?.spec &&
          !browser.currentURI.spec.startsWith("about:")
        ) {
          try {
            const currentURL = new URL(browser.currentURI.spec);
            const hostname = currentURL.hostname.replace(/^www\./, "");
            if (
              hostname &&
              hostname !== "localhost" &&
              hostname !== "127.0.0.1"
            ) {
              return hostname;
            }
          } catch {}
        }
        return "Untitled Page";
      }
      return originalTitle.trim() || "Untitled Page";
    } catch (e) {
      return "Error Processing Tab";
    }
  };

  const getTabData = (tab) => {
    if (!tab || !tab.isConnected) return { title: "Invalid", url: "" };
    let title = getTabTitle(tab);
    let url = "";
    try {
      const browser =
        tab.linkedBrowser ||
        tab._linkedBrowser ||
        gBrowser?.getBrowserForTab?.(tab);
      if (browser?.currentURI?.spec) url = browser.currentURI.spec;
    } catch (e) {}
    return { title, url };
  };

  const toTitleCase = (str) => {
    if (!str || typeof str !== "string") return "";
    return str
      .toLowerCase()
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  };

  const levenshteinDistance = (a, b) => {
    if (!a || !b) return Math.max(a?.length ?? 0, b?.length ?? 0);
    a = a.toLowerCase();
    b = b.toLowerCase();
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost,
        );
      }
    }
    return matrix[b.length][a.length];
  };

  // --- LOCAL AI HELPERS (Embeddings) ---
  function averageEmbedding(arrays) {
    if (!Array.isArray(arrays) || arrays.length === 0) return [];
    if (typeof arrays[0] === "number") return arrays;
    const len = arrays[0].length;
    const avg = new Array(len).fill(0);
    for (const arr of arrays) {
      for (let i = 0; i < len; i++) avg[i] += arr[i];
    }
    for (let i = 0; i < len; i++) avg[i] /= arrays.length;
    return avg;
  }

  function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return 0;
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  function clusterEmbeddings(vectors, threshold) {
    if (!vectors || vectors.length === 0) return [];
    const groups = [];
    const used = new Array(vectors.length).fill(false);
    for (let i = 0; i < vectors.length; i++) {
      if (used[i]) continue;
      const group = [i];
      used[i] = true;
      for (let j = 0; j < vectors.length; j++) {
        if (
          i !== j &&
          !used[j] &&
          cosineSimilarity(vectors[i], vectors[j]) > threshold
        ) {
          group.push(j);
          used[j] = true;
        }
      }
      groups.push(group);
    }
    return groups;
  }

  const generateEmbedding = async (title) => {
    try {
      const { createEngine } = ChromeUtils.importESModule(
        "chrome://global/content/ml/EngineProcess.sys.mjs",
      );
      const engine = await createEngine({
        taskName: "feature-extraction",
        modelId: "Mozilla/smart-tab-embedding",
        modelHub: "huggingface",
        engineId: "embedding-engine",
      });
      const result = await engine.run({ args: [title] });
      let embedding = result?.[0]?.embedding || result?.[0] || result;
      if (!Array.isArray(embedding)) return null;

      const pooled = averageEmbedding(embedding);
      const norm = Math.sqrt(pooled.reduce((sum, v) => sum + v * v, 0));
      return norm === 0 ? pooled : pooled.map((v) => v / norm);
    } catch (e) {
      console.error("[TabSort][LocalAI] Embedding error:", e);
      return null;
    }
  };

  const processTabsInBatches = async (tabs, batchSize = 5) => {
    const results = [];
    for (let i = 0; i < tabs.length; i += batchSize) {
      const batch = tabs.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map((tab) => generateEmbedding(getTabTitle(tab))),
      );
      results.push(...batchResults);
    }
    return results;
  };

  // --- MAIN AI CONTROLLER ---
  const askAIForMultipleTopics = async (tabs) => {
    const provider = getPref(PREFS.PROVIDER, "int", 0); // 0 = Local, 1 = Gemini

    // --- PATH A: GEMINI (Cloud) ---
    if (provider === 1) {
      console.log("[TabSort] Using GEMINI Provider");
      const apiKey = getPref(PREFS.GEMINI_KEY, "string", "");
      const model = getPref(PREFS.GEMINI_MODEL, "string", "gemini-2.0-flash");

      if (!apiKey) {
        console.error(
          "Gemini API Key missing. Please set it in Zen Tidy Tabs preferences.",
        );
        return tabs.map((t) => ({ tab: t, topic: "Missing API Key" }));
      }

      const validTabs = tabs.filter((t) => t && t.isConnected);
      const tabDataList = validTabs
        .map((t, i) => {
          const data = getTabData(t);
          return `${i + 1}. Title: "${data.title}", URL: "${data.url}"`;
        })
        .join("\n");

      const currentWorkspaceId = window.gZenWorkspaces?.activeWorkspace;
      let existingGroupsList = "None";
      if (currentWorkspaceId) {
        const groups = [];
        document
          .querySelectorAll(
            `tab-group:has(tab[zen-workspace-id="${currentWorkspaceId}"])`,
          )
          .forEach((g) => {
            const l = g.getAttribute("label");
            if (l) groups.push(l);
          });
        if (groups.length) existingGroupsList = groups.join(", ");
      }

      const prompt = `
        Analyze the following tabs and assign a concise category (1-2 words, Title Case) for EACH.
        
        Existing Categories: ${existingGroupsList}
        
        Rules:
        1. If a tab fits an Existing Category, use that EXACT name.
        2. Otherwise, create a new concise category.
        3. Output ONLY the list of categories, one per line, matching the input order. No numbering.

        Tabs:
        ${tabDataList}
        `;

      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.1 },
            }),
          },
        );

        if (!response.ok) throw new Error(`API Error: ${response.status}`);
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        if (!text) throw new Error("Empty response from Gemini");

        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l);

        return validTabs.map((tab, i) => {
          let topic = lines[i]
            ? toTitleCase(lines[i].replace(/[^\w\s]/g, ""))
            : "Uncategorized";
          return { tab, topic };
        });
      } catch (e) {
        console.error("[TabSort] Gemini Error:", e);
      }
    }

    // --- PATH B: LOCAL (Firefox Built-in) ---
    console.log("[TabSort] Using LOCAL Firefox AI");

    const validTabs = tabs.filter((tab) => tab?.isConnected);
    if (!validTabs.length) return [];

    const currentWorkspaceId = window.gZenWorkspaces?.activeWorkspace;
    const result = [];
    const ungroupedTabs = [];

    const existingWorkspaceGroups = new Map();
    const existingGroupEmbeddings = new Map();

    if (currentWorkspaceId) {
      document
        .querySelectorAll(
          `tab-group:has(tab[zen-workspace-id="${currentWorkspaceId}"])`,
        )
        .forEach((groupEl) => {
          const label = groupEl.getAttribute("label");
          if (label) {
            const groupTabs = Array.from(
              groupEl.querySelectorAll("tab"),
            ).filter(
              (tab) =>
                tab.getAttribute("zen-workspace-id") === currentWorkspaceId,
            );
            if (groupTabs.length > 0) {
              existingWorkspaceGroups.set(label, {
                element: groupEl,
                tabs: groupTabs,
                tabTitles: groupTabs.map((t) => getTabTitle(t)),
              });
            }
          }
        });
    }

    const tabTitles = validTabs.map((t) => getTabTitle(t));
    const embeddings = await processTabsInBatches(validTabs);

    for (const [groupName, groupInfo] of existingWorkspaceGroups) {
      try {
        const groupTabEmbeddings = await processTabsInBatches(groupInfo.tabs);
        const valid = groupTabEmbeddings.filter(
          (e) => Array.isArray(e) && e.length > 0,
        );
        if (valid.length > 0) {
          existingGroupEmbeddings.set(groupName, averageEmbedding(valid));
        }
      } catch (e) {}
    }

    for (let i = 0; i < validTabs.length; i++) {
      const tab = validTabs[i];
      const tabEmbedding = embeddings[i];
      const tabTitle = tabTitles[i];

      if (!tabEmbedding) {
        ungroupedTabs.push(tab);
        continue;
      }

      let bestMatch = null;
      let bestSimilarity = 0;

      for (const [groupName, groupInfo] of existingWorkspaceGroups) {
        const groupEmbedding = existingGroupEmbeddings.get(groupName);
        if (!groupEmbedding) continue;

        let similarity =
          cosineSimilarity(tabEmbedding, groupEmbedding) +
          CONFIG.EXISTING_GROUP_BOOST;

        if (
          similarity > CONFIG.GROUP_SIMILARITY_THRESHOLD &&
          similarity > bestSimilarity
        ) {
          bestMatch = { groupName, similarity };
          bestSimilarity = similarity;
        }
      }

      if (!bestMatch) {
        for (const [groupName, groupInfo] of existingWorkspaceGroups) {
          const maxSim = Math.max(
            ...groupInfo.tabTitles.map((t) => {
              const dist = levenshteinDistance(tabTitle, t);
              return 1 - dist / Math.max(tabTitle.length, t.length);
            }),
          );
          if (maxSim > 0.7) {
            bestMatch = { groupName, similarity: maxSim };
          }
        }
      }

      if (bestMatch) {
        result.push({ tab, topic: bestMatch.groupName });
      } else {
        ungroupedTabs.push(tab);
      }
    }

    if (ungroupedTabs.length > 1) {
      const ungroupedEmbeddings = await processTabsInBatches(ungroupedTabs);
      const validIndices = ungroupedEmbeddings
        .map((e, i) => (Array.isArray(e) && e.length > 0 ? i : -1))
        .filter((i) => i !== -1);
      const validEmbeddings = validIndices.map((i) => ungroupedEmbeddings[i]);

      if (validEmbeddings.length > 1) {
        const clusters = clusterEmbeddings(
          validEmbeddings,
          CONFIG.SIMILARITY_THRESHOLD,
        );

        async function nameGroup(titles) {
          try {
            const allWords = titles
              .join(" ")
              .toLowerCase()
              .replace(/[^\w\s]/g, " ")
              .split(/\s+/)
              .filter((w) => w.length > 2);
            const wordCount = {};
            allWords.forEach((w) => (wordCount[w] = (wordCount[w] || 0) + 1));
            const keywords = Object.entries(wordCount)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map((x) => x[0]);

            const input = `Topic from keywords: ${keywords.join(", ")}. titles:\n${titles.join("\n")}`;
            const { createEngine } = ChromeUtils.importESModule(
              "chrome://global/content/ml/EngineProcess.sys.mjs",
            );
            let engine = await createEngine({
              taskName: "text2text-generation",
              modelId: "Mozilla/smart-tab-topic",
              modelHub: "huggingface",
              engineId: "group-namer",
            });
            const aiResult = await engine.run({
              args: [input],
              options: { max_new_tokens: 8, temperature: 0.7 },
            });
            let name = (aiResult[0]?.generated_text || "Group")
              .split("\n")[0]
              .trim();
            return toTitleCase(name.replace(/^['"]|['"]$/g, "")) || "Group";
          } catch (e) {
            return toTitleCase(titles[0].split(" ")[0]);
          }
        }

        for (const cluster of clusters) {
          if (cluster.length < 2) continue;
          const groupTabs = cluster.map(
            (idx) => ungroupedTabs[validIndices[idx]],
          );
          const groupTitles = groupTabs.map((t) => getTabTitle(t));
          const groupName = await nameGroup(groupTitles);
          groupTabs.forEach((tab) => result.push({ tab, topic: groupName }));
        }
      }
    }

    return result;
  };

  // --- Animation & UI Logic ---
  const startFailureAnimation = () => {
    if (sortAnimationId !== null) cancelAnimationFrame(sortAnimationId);
    isPlayingFailureAnimation = true;
    try {
      const activeWorkspace = gZenWorkspaces?.activeWorkspaceElement;
      const activeSeparator = activeWorkspace?.querySelector(
        ".pinned-tabs-container-separator:not(.has-no-sortable-tabs)",
      );
      const pathElement = activeSeparator?.querySelector("#separator-path");
      if (pathElement) {
        const maxAmplitude = 8;
        const pulseDuration = 400;
        const totalPulses = 3;
        let currentPulse = 0,
          t = 0,
          startTime = performance.now(),
          pulseStartTime = startTime;

        function animateFailureLoop(timestamp) {
          if (sortAnimationId === null) return;
          const elapsedSincePulseStart = timestamp - pulseStartTime;
          const pulseProgress = elapsedSincePulseStart / pulseDuration;
          if (pulseProgress >= 1) {
            currentPulse++;
            if (currentPulse >= totalPulses) {
              pathElement.setAttribute("d", "M 0 1 L 100 1");
              sortAnimationId = null;
              isPlayingFailureAnimation = false;
              return;
            }
            pulseStartTime = timestamp;
          }
          const currentProgress = Math.min(pulseProgress, 1);
          const intensity = Math.sin(currentProgress * Math.PI);
          const currentAmplitude = maxAmplitude * intensity;
          t += 1.2;
          const points = [];
          for (let i = 0; i <= 100; i++) {
            const x = i;
            const baseWave = Math.sin((x / 5) * 2 * Math.PI + t * 0.15);
            const sharpWave =
              Math.sign(baseWave) * Math.pow(Math.abs(baseWave), 0.3);
            const y = 1 + currentAmplitude * sharpWave;
            points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
          }
          pathElement.setAttribute("d", "M" + points.join(" L"));
          sortAnimationId = requestAnimationFrame(animateFailureLoop);
        }
        sortAnimationId = requestAnimationFrame(animateFailureLoop);
      }
    } catch (e) {
      isPlayingFailureAnimation = false;
    }
  };

  const cleanupAnimation = () => {
    if (isPlayingFailureAnimation) return;
    if (sortAnimationId !== null) {
      cancelAnimationFrame(sortAnimationId);
      sortAnimationId = null;
      try {
        const activeWorkspace = gZenWorkspaces?.activeWorkspaceElement;
        const pathElement = activeWorkspace?.querySelector("#separator-path");
        if (pathElement) pathElement.setAttribute("d", "M 0 1 L 100 1");
      } catch (e) {}
    }
  };

  const sortTabsByTopic = async () => {
    if (isSorting) return;
    isSorting = true;
    let separatorsToSort = [];

    try {
      separatorsToSort = domCache.getSeparators();
      separatorsToSort.forEach((s) => s.classList.add("separator-is-sorting"));

      const currentWorkspaceId = window.gZenWorkspaces?.activeWorkspace;
      if (!currentWorkspaceId) return;

      const initialTabsToSort = getFilteredTabs(currentWorkspaceId);
      if (initialTabsToSort.length === 0) return;

      const aiTabTopics = await askAIForMultipleTopics(initialTabsToSort);

      const finalGroups = {};
      aiTabTopics.forEach(({ tab, topic }) => {
        if (!topic || topic === "Uncategorized" || !tab?.isConnected) return;
        if (!finalGroups[topic]) finalGroups[topic] = [];
        finalGroups[topic].push(tab);
      });

      const keys = Object.keys(finalGroups);
      const merged = new Set();
      for (let i = 0; i < keys.length; i++) {
        if (merged.has(keys[i])) continue;
        for (let j = i + 1; j < keys.length; j++) {
          if (merged.has(keys[j])) continue;
          if (
            levenshteinDistance(keys[i], keys[j]) <=
            CONFIG.CONSOLIDATION_DISTANCE_THRESHOLD
          ) {
            finalGroups[keys[i]].push(...finalGroups[keys[j]]);
            delete finalGroups[keys[j]];
            merged.add(keys[j]);
          }
        }
      }

      const multiTabGroups = Object.values(finalGroups).filter(
        (t) => t.length > 0,
      );

      if (multiTabGroups.length === 0 && initialTabsToSort.length > 1) {
        startFailureAnimation();
        return;
      }

      const existingGroupElementsMap = new Map();
      document
        .querySelectorAll(
          `tab-group:has(tab[zen-workspace-id="${currentWorkspaceId}"])`,
        )
        .forEach((g) => {
          existingGroupElementsMap.set(g.getAttribute("label"), g);
        });

      for (const topic in finalGroups) {
        const tabs = finalGroups[topic];
        if (!tabs.length) continue;

        let groupEl = existingGroupElementsMap.get(topic);

        if (groupEl && groupEl.isConnected) {
          if (groupEl.getAttribute("collapsed") === "true")
            groupEl.setAttribute("collapsed", "false");
          tabs.forEach((t) => gBrowser.moveTabToExistingGroup(t, groupEl));
        } else {
          try {
            const newGroup = gBrowser.addTabGroup(tabs, {
              label: topic,
              insertBefore: tabs[0],
            });
            if (newGroup) {
              existingGroupElementsMap.set(topic, newGroup);
              if (newGroup._useFaviconColor)
                setTimeout(() => newGroup._useFaviconColor(), 500);
            }
          } catch (e) {
            console.error(e);
          }
        }
      }
    } catch (e) {
      console.error("[TabSort] Critical Error:", e);
    } finally {
      if (isPlayingFailureAnimation) {
        setTimeout(() => {
          isSorting = false;
          cleanupAnimation();
          separatorsToSort.forEach((s) =>
            s.classList.remove("separator-is-sorting"),
          );
          updateButtonsVisibilityState();
        }, 1500);
      } else {
        isSorting = false;
        cleanupAnimation();
        separatorsToSort.forEach((s) =>
          s.classList.remove("separator-is-sorting"),
        );
        updateButtonsVisibilityState();
      }
    }
  };

  function ensureSortButtonExists(separator) {
    if (!separator || separator.querySelector("#sort-button")) return;

    if (!separator.querySelector("svg.separator-line-svg")) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "separator-line-svg");
      svg.setAttribute("viewBox", "0 0 100 2");
      svg.innerHTML = `<path id="separator-path" class="separator-path-segment" d="M 0 1 L 100 1" stroke-width="1" stroke-linecap="round" style="fill:none; opacity:1;"/>`;
      separator.insertBefore(svg, separator.firstChild);
    }

    const nativeClear = separator.querySelector(
      ".zen-workspace-close-unpinned-tabs-button",
    );

    const btn = window.MozXULElement.parseXULToFragment(
      `
        <toolbarbutton id="sort-button" class="sort-button-with-icon" command="cmd_zenSortTabs" tooltiptext="Sort Tabs (AI)">
            <hbox class="toolbarbutton-box" align="center">
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" class="broom-icon">
                   <g><path d="M19.9132 21.3765C19.8875 21.0162 19.6455 20.7069 19.3007 20.5993L7.21755 16.8291C6.87269 16.7215 6.49768 16.8384 6.27165 17.1202C5.73893 17.7845 4.72031 19.025 3.78544 19.9965C2.4425 21.392 3.01177 22.4772 4.66526 22.9931C4.82548 23.0431 5.78822 21.7398 6.20045 21.7398C6.51906 21.8392 6.8758 23.6828 7.26122 23.8031C7.87402 23.9943 8.55929 24.2081 9.27891 24.4326C9.59033 24.5298 10.2101 23.0557 10.5313 23.1559C10.7774 23.2327 10.7236 24.8834 10.9723 24.961C11.8322 25.2293 12.699 25.4997 13.5152 25.7544C13.868 25.8645 14.8344 24.3299 15.1637 24.4326C15.496 24.5363 15.191 26.2773 15.4898 26.3705C16.7587 26.7664 17.6824 27.0546 17.895 27.1209C19.5487 27.6369 20.6333 27.068 20.3226 25.1563C20.1063 23.8255 19.9737 22.2258 19.9132 21.3765Z" stroke="none"/>
                   <path d="M16.719 1.7134C17.4929-0.767192 20.7999 0.264626 20.026 2.74523C19.2521 5.22583 18.1514 8.75696 17.9629 9.36C17.7045 10.1867 16.1569 15.1482 15.899 15.9749L19.2063 17.0068C20.8597 17.5227 20.205 19.974 18.4514 19.4268L8.52918 16.331C6.87208 15.8139 7.62682 13.3938 9.28426 13.911L12.5916 14.9429C12.8495 14.1163 14.3976 9.15491 14.6555 8.32807C14.9135 7.50122 15.9451 4.19399 16.719 1.7134Z" stroke="none"/></g>
                </svg>
                <label value="Sort" class="toolbarbutton-text" style="margin-left: 4px;"/>
            </hbox>
        </toolbarbutton>`,
    ).firstChild.cloneNode(true);

    if (nativeClear) separator.insertBefore(btn, nativeClear);
    else separator.appendChild(btn);
  }

  function addSortButtonToAllSeparators() {
    domCache.getSeparators().forEach(ensureSortButtonExists);
    updateButtonsVisibilityState();
  }

  const updateButtonsVisibilityState = () => {
    domCache.getSeparators().forEach((sep) => {
      const btn = sep.querySelector("#sort-button");
      if (btn) btn.classList.remove("hidden-button");
    });
  };

  function debounce(func, wait) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), wait);
    };
  }

  function initializeScript() {
    // Apply UI Theme
    applyUserStyles();

    const cmdSet = domCache.getCommandSet();
    if (cmdSet && !cmdSet.querySelector("#cmd_zenSortTabs")) {
      const cmd = window.MozXULElement.parseXULToFragment(
        '<command id="cmd_zenSortTabs"/>',
      ).firstChild;
      cmdSet.appendChild(cmd);

      cmdSet.addEventListener("command", (e) => {
        if (e.target.id === "cmd_zenSortTabs") {
          const sep = document.querySelector(
            ".pinned-tabs-container-separator",
          );
          const btn = sep?.querySelector("#sort-button");
          if (btn) {
            btn.classList.add("brushing");
            setTimeout(() => btn.classList.remove("brushing"), 800);
          }

          const path = sep?.querySelector("#separator-path");
          if (path) {
            let t = 0;
            const start = performance.now();
            const animate = () => {
              if (isSorting && !isPlayingFailureAnimation) {
                t += 0.5;
                const points = [];
                for (let i = 0; i <= 50; i++) {
                  const x = i * 2;
                  const y = 1 + 3 * Math.sin((x / 12.5) * Math.PI + t * 0.1);
                  points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
                }
                path.setAttribute("d", "M" + points.join(" L"));
                requestAnimationFrame(animate);
              }
            };
            requestAnimationFrame(animate);
          }

          sortTabsByTopic();
        }
      });
    }

    addSortButtonToAllSeparators();

    if (window.gZenWorkspaces) {
      const origInsert = window.gZenWorkspaces.onTabBrowserInserted;
      window.gZenWorkspaces.onTabBrowserInserted = function (e) {
        if (origInsert) origInsert.call(this, e);
        addSortButtonToAllSeparators();
      };

      const origUpdate = window.gZenWorkspaces.updateTabsContainers;
      window.gZenWorkspaces.updateTabsContainers = function (...args) {
        if (origUpdate) origUpdate.apply(this, args);
        addSortButtonToAllSeparators();
      };
    }

    const update = debounce(updateButtonsVisibilityState, 250);
    [
      "TabOpen",
      "TabClose",
      "TabSelect",
      "TabPinned",
      "TabUnpinned",
      "TabGrouped",
      "TabUngrouped",
    ].forEach((ev) => {
      gBrowser.tabContainer.addEventListener(ev, update);
    });
    window.addEventListener("zen-workspace-switched", update);
  }

  if (document.readyState === "complete") initializeScript();
  else window.addEventListener("load", initializeScript, { once: true });
})();
