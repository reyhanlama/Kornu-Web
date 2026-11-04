import { DOMPurify } from './ebook/book-view.js';

const formats = {
  epub: ['EPUB', 'application/epub+zip'],
  mobi: ['MOBI', 'application/x-mobipocket-ebook'],
  azw: ['AZW', 'application/vnd.amazon.ebook'],
  azw3: ['AZW3', 'application/vnd.amazon.ebook'],
  fb2: ['FB2', 'application/x-fictionbook+xml'],
  fbz: ['FBZ', 'application/zip'],
  cbz: ['CBZ', 'application/vnd.comicbook+zip']
};

const value = (input) => {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return value(input[0]);
  if (input && typeof input === 'object') return value(input.name || Object.values(input)[0]);
  return '';
};

export async function inspectBook(file) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const format = formats[extension];
  if (!format) throw new Error('Choose an EPUB, AZW3, MOBI, FB2, or CBZ book.');
  if (!file.size || file.size > 50 * 1024 * 1024) throw new Error('Choose a book smaller than 50 MB.');
  const normalized = new File([file], file.name, { type: format[1] });
  const { makeBook } = await import('./ebook/book-view.js');
  let book;
  try {
    book = await makeBook(normalized);
    if (!book.sections?.length) throw new Error('This book has no readable pages.');
    const title = value(book.metadata?.title).trim() || file.name.replace(/\.[^.]+$/, '');
    const author = value(book.metadata?.author).trim();
    let cover = null;
    try {
      const image = await book.getCover?.();
      if (image && image.size <= 4 * 1024 * 1024 && ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(image.type)) cover = image;
    } catch { /* A missing cover does not prevent reading. */ }
    return { file: normalized, title, author, format: format[0], cover };
  } finally { book?.destroy?.(); }
}

const cleanChapter = (html) => DOMPurify.sanitize(html, {
  ALLOWED_TAGS: ['p', 'div', 'section', 'article', 'span', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'em', 'strong', 'b', 'i', 'u', 's', 'small', 'sup', 'sub', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'figure', 'figcaption', 'img', 'a'],
  ALLOWED_ATTR: ['src', 'alt', 'title', 'href', 'id', 'colspan', 'rowspan'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?:|mailto:|tel:|blob:|data:image\/(?:png|jpeg|gif|webp|avif);base64,)|[#/])/i
});

export async function openBook(container, file, item, onRelocate) {
  const { makeBook } = await import('./ebook/book-view.js');
  const source = new File([file], item.filename || `${item.title}.${item.format?.toLowerCase() || 'epub'}`, { type: item.fileType || file.type });
  const book = await makeBook(source);
  let current = -1;
  let closed = false;
  let serial = 0;
  let coverURL = null;

  const goToIndex = async (requested) => {
    const index = Math.max(0, Math.min(book.sections.length - 1, Number(requested) || 0));
    if (index === current) return;
    const request = ++serial;
    const section = book.sections[index];
    const oldSection = book.sections[current];
    try {
      const url = await section.load();
      if (!url) throw new Error('This chapter has no readable content.');
      if (closed || request !== serial) { section.unload?.(); return; }
      let content;
      if (item.format === 'CBZ') {
        const page = await fetch(url).then((response) => response.text());
        const sourceURL = new DOMParser().parseFromString(page, 'text/html').querySelector('img')?.getAttribute('src');
        if (!sourceURL?.startsWith(`blob:${location.origin}/`)) throw new Error('A comic page image is missing.');
        const image = document.createElement('img');
        image.src = sourceURL;
        image.alt = `Page ${index + 1}`;
        image.className = 'book-comic-page';
        content = image;
      } else {
        const response = await fetch(url);
        if (!response.ok) throw new Error('A chapter could not be read.');
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const chapter = document.createElement('div');
        chapter.className = 'book-chapter';
        chapter.innerHTML = cleanChapter(doc.body?.innerHTML || html);
        if (index === 0 && !chapter.textContent.trim() && !chapter.querySelector('img')) {
          const cover = await book.getCover?.();
          if (cover && ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(cover.type)) {
            if (coverURL) URL.revokeObjectURL(coverURL);
            coverURL = URL.createObjectURL(cover);
            const image = document.createElement('img');
            image.src = coverURL;
            image.alt = `${item.title} cover`;
            chapter.classList.add('book-cover-page');
            chapter.append(image);
          }
        }
        for (const link of chapter.querySelectorAll('a[href]')) {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
        content = chapter;
      }
      if (closed || request !== serial) { section.unload?.(); return; }
      container.replaceChildren(content);
      container.scrollTop = 0;
      current = index;
      if (oldSection && oldSection !== section) oldSection.unload?.();
      onRelocate({ index, fraction: (index + 1) / book.sections.length });
    } catch (error) {
      section.unload?.();
      if (closed || request !== serial) return;
      const message = document.createElement('div');
      message.className = 'book-loading book-load-error';
      const title = document.createElement('strong');
      title.textContent = 'Could not read this chapter.';
      const detail = document.createElement('p');
      detail.textContent = error.message || 'This chapter is damaged.';
      message.append(title, detail);
      container.replaceChildren(message);
    }
  };

  await goToIndex(Number.isInteger(item.bookLocation) ? item.bookLocation : 0);
  return {
    book,
    next: () => goToIndex(current + 1),
    prev: () => goToIndex(current - 1),
    goLeft: () => goToIndex(current - 1),
    goRight: () => goToIndex(current + 1),
    goTo: (href) => { const target = book.resolveHref?.(href); if (target?.index >= 0) goToIndex(target.index); },
    close: () => { closed = true; serial++; book.sections[current]?.unload?.(); book.destroy?.(); if (coverURL) URL.revokeObjectURL(coverURL); }
  };
}
