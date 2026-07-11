import type { ProjectFile } from './types';

export interface CodeEditorAPI {
  getFiles(): ProjectFile[];
  setFiles(files: ProjectFile[]): void;
  getActiveFileName(): string;
  getCombinedCode(): string;
  onDidChange(cb: () => void): void;
  focus(): void;
  setActiveContent(code: string): void;
}

// ─── Syntax highlighting tokenizer ──────────────────────────────────────────

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'new', 'true', 'false', 'null', 'undefined', 'class', 'extends', 'import',
  'export', 'from', 'typeof', 'this', 'break', 'continue', 'switch', 'case',
  'default', 'throw', 'try', 'catch', 'finally',
]);

function highlightCode(code: string): string {
  // Escape HTML first
  const escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Tokenize with regex — order matters
  return escaped.replace(
    /(\/\/.*$)|(\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|(\b[a-zA-Z_$]\w*\b)/gm,
    (match, lineComment, blockComment, str, num, word) => {
      if (lineComment) return `<span class="hl-comment">${lineComment}</span>`;
      if (blockComment) return `<span class="hl-comment">${blockComment}</span>`;
      if (str) return `<span class="hl-string">${str}</span>`;
      if (num) return `<span class="hl-number">${num}</span>`;
      if (word && KEYWORDS.has(word)) return `<span class="hl-keyword">${word}</span>`;
      return match;
    },
  );
}

// ─── Line numbers ───────────────────────────────────────────────────────────

function updateLineNumbers(textarea: HTMLTextAreaElement, gutter: HTMLElement) {
  const lines = textarea.value.split('\n').length;
  const nums: string[] = [];
  for (let i = 1; i <= lines; i++) nums.push(String(i));
  gutter.textContent = nums.join('\n');
}

function syncScroll(textarea: HTMLTextAreaElement, gutter: HTMLElement, highlight: HTMLElement) {
  gutter.scrollTop = textarea.scrollTop;
  highlight.scrollTop = textarea.scrollTop;
  highlight.scrollLeft = textarea.scrollLeft;
}

// ─── Init ───────────────────────────────────────────────────────────────────

export function initCodeEditor(container: HTMLElement): CodeEditorAPI {
  let files: ProjectFile[] = [{ name: 'main.js', content: '' }];
  let activeFile = 'main.js';
  const changeCallbacks: (() => void)[] = [];

  // ─── Find / create DOM elements ─────────────────────────────────────────

  const editorArea = container.querySelector('.editor-area') as HTMLElement;

  // Create file tabs bar
  const tabsBar = document.createElement('div');
  tabsBar.className = 'file-tabs-bar';
  editorArea.insertBefore(tabsBar, editorArea.firstChild);

  // Wrap textarea in a code-editor-wrapper
  const textarea = editorArea.querySelector('#code-editor') as HTMLTextAreaElement;
  const consoleOutput = editorArea.querySelector('#console-output') as HTMLElement;

  const wrapper = document.createElement('div');
  wrapper.className = 'code-editor-wrapper';

  const gutter = document.createElement('div');
  gutter.className = 'line-numbers';

  const highlightPre = document.createElement('pre');
  highlightPre.className = 'editor-highlight';
  highlightPre.setAttribute('aria-hidden', 'true');

  // Create content row (wrapper + console side by side)
  const contentRow = document.createElement('div');
  contentRow.className = 'editor-area-content';

  // Rearrange DOM
  wrapper.appendChild(gutter);
  wrapper.appendChild(highlightPre);
  wrapper.appendChild(textarea);
  contentRow.appendChild(wrapper);
  contentRow.appendChild(consoleOutput);

  editorArea.innerHTML = '';
  editorArea.appendChild(tabsBar);
  editorArea.appendChild(contentRow);

  // ─── Update highlight overlay ───────────────────────────────────────────

  function updateHighlight() {
    highlightPre.innerHTML = highlightCode(textarea.value) + '\n'; // trailing newline ensures last line aligns
  }

  // ─── Render tabs ────────────────────────────────────────────────────────

  function renderTabs() {
    tabsBar.innerHTML = '';
    files.forEach((file) => {
      const tab = document.createElement('div');
      tab.className = 'file-tab' + (file.name === activeFile ? ' active' : '');
      tab.draggable = true;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'file-tab-name';
      nameSpan.textContent = file.name;
      tab.appendChild(nameSpan);

      // Double-click to rename
      nameSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const newName = prompt('Rename file:', file.name);
        if (newName && newName !== file.name && !files.some(f => f.name === newName)) {
          if (activeFile === file.name) activeFile = newName;
          file.name = newName;
          renderTabs();
          notifyChange();
        }
      });

      if (files.length > 1) {
        const closeBtn = document.createElement('span');
        closeBtn.className = 'close-btn';
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (files.length <= 1) return;
          if (!confirm(`Delete "${file.name}"?`)) return;
          files = files.filter(f => f.name !== file.name);
          if (activeFile === file.name) {
            activeFile = files[0].name;
            loadFileContent(activeFile);
          }
          renderTabs();
          notifyChange();
        });
        tab.appendChild(closeBtn);
      }

      tab.addEventListener('click', () => {
        if (activeFile !== file.name) {
          saveCurrentContent();
          activeFile = file.name;
          loadFileContent(activeFile);
          renderTabs();
        }
      });

      // Drag & drop reorder
      tab.addEventListener('dragstart', (e) => {
        e.dataTransfer!.setData('text/plain', file.name);
        tab.classList.add('dragging');
      });
      tab.addEventListener('dragend', () => tab.classList.remove('dragging'));
      tab.addEventListener('dragover', (e) => {
        e.preventDefault();
        tab.classList.add('drag-over');
      });
      tab.addEventListener('dragleave', () => tab.classList.remove('drag-over'));
      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        tab.classList.remove('drag-over');
        const draggedName = e.dataTransfer!.getData('text/plain');
        if (draggedName === file.name) return;
        const draggedIdx = files.findIndex(f => f.name === draggedName);
        const targetIdx = files.findIndex(f => f.name === file.name);
        if (draggedIdx < 0 || targetIdx < 0) return;
        const [moved] = files.splice(draggedIdx, 1);
        files.splice(targetIdx, 0, moved);
        renderTabs();
        notifyChange();
      });

      tabsBar.appendChild(tab);
    });

    // Add "+" button
    const addBtn = document.createElement('div');
    addBtn.className = 'file-tab file-tab-add';
    addBtn.textContent = '+';
    addBtn.title = 'New file';
    addBtn.addEventListener('click', () => {
      let n = files.length + 1;
      let name = `file${n}.js`;
      while (files.some(f => f.name === name)) {
        n++;
        name = `file${n}.js`;
      }
      const inputName = prompt('File name:', name);
      if (!inputName) return;
      saveCurrentContent();
      files.push({ name: inputName, content: '' });
      activeFile = inputName;
      loadFileContent(inputName);
      renderTabs();
      notifyChange();
    });
    tabsBar.appendChild(addBtn);
  }

  // ─── File content management ────────────────────────────────────────────

  function saveCurrentContent() {
    const file = files.find(f => f.name === activeFile);
    if (file) file.content = textarea.value;
  }

  function loadFileContent(name: string) {
    const file = files.find(f => f.name === name);
    textarea.value = file ? file.content : '';
    updateLineNumbers(textarea, gutter);
    updateHighlight();
    textarea.scrollTop = 0;
    syncScroll(textarea, gutter, highlightPre);
  }

  function notifyChange() {
    changeCallbacks.forEach(cb => cb());
  }

  // ─── Event listeners ───────────────────────────────────────────────────

  textarea.addEventListener('input', () => {
    updateLineNumbers(textarea, gutter);
    updateHighlight();
    notifyChange();
  });

  textarea.addEventListener('scroll', () => {
    syncScroll(textarea, gutter, highlightPre);
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;

      if (e.shiftKey) {
        // Dedent
        const before = textarea.value.substring(0, start);
        const lineStart = before.lastIndexOf('\n') + 1;
        const linePrefix = textarea.value.substring(lineStart, start);
        if (linePrefix.startsWith('  ')) {
          textarea.value = textarea.value.substring(0, lineStart) +
            textarea.value.substring(lineStart).replace(/^ {1,2}/, '');
          textarea.selectionStart = textarea.selectionEnd = Math.max(start - 2, lineStart);
        }
      } else {
        // Indent
        textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      }
      updateLineNumbers(textarea, gutter);
      updateHighlight();
      notifyChange();
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const start = textarea.selectionStart;
      const before = textarea.value.substring(0, start);
      const lineStart = before.lastIndexOf('\n') + 1;
      const currentLine = before.substring(lineStart);
      const indent = currentLine.match(/^\s*/)?.[0] || '';
      const insert = '\n' + indent;
      textarea.value = textarea.value.substring(0, start) + insert + textarea.value.substring(textarea.selectionEnd);
      textarea.selectionStart = textarea.selectionEnd = start + insert.length;
      updateLineNumbers(textarea, gutter);
      updateHighlight();
      notifyChange();
    }
  });

  // ─── Initialize ─────────────────────────────────────────────────────────

  // Capture existing textarea content as initial main.js content
  files[0].content = textarea.value;
  updateLineNumbers(textarea, gutter);
  updateHighlight();
  renderTabs();

  // ─── Public API ─────────────────────────────────────────────────────────

  return {
    getFiles() {
      saveCurrentContent();
      return [...files];
    },
    setFiles(newFiles: ProjectFile[]) {
      files = newFiles.length > 0 ? [...newFiles] : [{ name: 'main.js', content: '' }];
      if (!files.some(f => f.name === activeFile)) {
        activeFile = files[0].name;
      }
      loadFileContent(activeFile);
      renderTabs();
    },
    getActiveFileName() {
      return activeFile;
    },
    getCombinedCode() {
      saveCurrentContent();
      return files
        .map(f => `// --- ${f.name} ---\n${f.content}`)
        .join('\n\n');
    },
    onDidChange(cb: () => void) {
      changeCallbacks.push(cb);
    },
    focus() {
      textarea.focus();
    },
    setActiveContent(code: string) {
      textarea.value = code;
      const file = files.find(f => f.name === activeFile);
      if (file) file.content = code;
      updateLineNumbers(textarea, gutter);
      updateHighlight();
    },
  };
}
