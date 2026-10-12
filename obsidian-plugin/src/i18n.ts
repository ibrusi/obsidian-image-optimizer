// Interface texts in English and Russian. The log note stays in English: it
// is meant for troubleshooting and for sending back with a bug report.

export type Language = 'en' | 'ru';
export type LanguageSetting = 'auto' | Language;

export interface Summary {
  converted: number;
  kept: number;
  failed: number;
  before: string;
  after: string;
}

export type FolderError =
  | { kind: 'dots' }
  | { kind: 'hidden'; segment: string }
  | { kind: 'forbidden'; segment: string };

const en = {
  commands: {
    optimizeNote: 'Optimize images in the current note',
    optimizeFolder: 'Optimize images in the current note\'s folder',
    optimizeVault: 'Optimize images in the whole vault',
    stop: 'Stop image optimization',
  },
  notices: {
    optimizing: 'Optimizing images…',
    noImages: 'No images to optimize in this note.',
    queued: 'Image optimization will start when the current one finishes.',
    failed: (error: string) => `Image optimization failed: ${error}`,
    placeDeleted: (embeds: string) => `The pasted image was saved, but its place in the note was deleted: ${embeds}`,
    details: (path: string) => `. Details: ${path}`,
    stopped: 'Stopped. ',
    migrated: (legacyId: string) => `Image Optimizer: the earlier version of the plugin is installed (folder ${legacyId}); its settings, if any, were taken over. ` +
      'Uninstall that version in Community plugins: with both enabled, every paste is handled twice.',
  },
  menu: {
    optimizeFolder: 'Optimize images in this folder',
  },
  placeholder: 'Optimizing image',
  progress: {
    title: 'Optimizing images in the vault',
    folderTitle: (folder: string) => `Optimizing images in ${folder}`,
    stop: 'Stop',
    note: (n: number, total: number, summary: string) => `Note ${n} of ${total}: ${summary}`,
  },
  summary: (s: Summary) => {
    const parts = [`${s.converted} ${s.converted === 1 ? 'image' : 'images'} converted`];
    if (s.before) parts.push(`${s.before} → ${s.after}`);
    if (s.kept) parts.push(`${s.kept} kept as is`);
    if (s.failed) parts.push(`${s.failed} failed`);
    return parts.join(', ');
  },
  folderError: (error: FolderError) => {
    switch (error.kind) {
      case 'dots': return 'The folder must not contain "." or ".." segments.';
      case 'hidden': return `Hidden folders are not shown by Obsidian: "${error.segment}".`;
      case 'forbidden': return `The folder name contains a character Obsidian does not allow: "${error.segment}".`;
    }
  },
  settings: {
    language: {
      name: 'Language',
      desc: 'Language of the plugin. "As in Obsidian" follows the interface language, English if the plugin does not have it.',
      auto: 'As in Obsidian',
    },
    folder: {
      name: 'Image folder',
      desc: 'Where downloaded and pasted images are saved. "Attachments" is a folder next to the note, ' +
        '"/Attachments" is one folder at the vault root, an empty value is the note\'s own folder. ' +
        'Plugin settings live in .obsidian/plugins: if your sync does not copy that folder, set this on every device.',
    },
    quality: {
      name: 'Quality',
      desc: 'Lossy WebP quality, 1–100. 40 keeps text and photos visually unchanged at a fraction of the size. ' +
        'Screenshots and screen recordings in PNG, BMP and GIF are encoded lossless instead, pixel for pixel.',
    },
    method: {
      name: 'Compression effort',
      desc: 'libwebp method. 4 is fast; 6 makes files about 5% smaller but is several times slower, noticeable on phones.',
      default: '4 (default)',
      smallest: '6 (smallest, slow)',
    },
    minSavings: {
      name: 'Minimum saving, %',
      desc: 'Keep the original unless the WebP is at least this much smaller.',
    },
    gif: {
      name: 'GIF',
      desc: 'Animated GIFs become animated WebP; "Keep GIF" leaves every GIF as it is.',
      convert: 'Convert to WebP',
      keep: 'Keep GIF',
    },
    convertLocal: {
      name: 'Convert images already in the vault',
      desc: 'Commands also convert local JPG, PNG, BMP and GIF images and move the originals to the vault trash (.trash).',
    },
    autoOnPaste: {
      name: 'Convert on paste and drop',
      desc: 'Pasted or dropped images, and web images in pasted text, are converted right away.',
    },
    reuseIdentical: {
      name: 'Reuse identical files',
      desc: 'Saved files get a short fingerprint of the original in their name (photo-3fa9c2e1b7d04a85.webp). An image added ' +
        'again — in another note, pasted twice, or on another device after sync — is linked to that file, even after the ' +
        'settings changed. Off: no fingerprint, every image is saved as a new file. Existing files are never changed.',
    },
    limits: 'Limits',
    maxDownload: {
      name: 'Maximum download, MB',
      desc: 'Larger downloads are refused.',
    },
    maxMegapixels: {
      name: 'Maximum image size, megapixels',
      desc: 'Larger images (for GIFs: width × height × frames) are kept as they are, to protect memory on phones.',
    },
    allowPrivateHosts: {
      name: 'Allow private network addresses',
      desc: 'Allow downloads from localhost and local network addresses written in links.',
    },
    writeLogNote: {
      name: 'Write a log note',
      desc: 'Append details of every run to image-optimizer-log.md, for troubleshooting. The log is in English.',
    },
  },
};

export type Strings = typeof en;

const ru: Strings = {
  commands: {
    optimizeNote: 'Сжать картинки в текущей заметке',
    optimizeFolder: 'Сжать картинки в папке текущей заметки',
    optimizeVault: 'Сжать картинки во всём хранилище',
    stop: 'Остановить сжатие картинок',
  },
  notices: {
    optimizing: 'Сжатие картинок…',
    noImages: 'В этой заметке нет картинок для сжатия.',
    queued: 'Сжатие начнётся, когда закончится текущее.',
    failed: (error) => `Не удалось сжать картинки: ${error}`,
    placeDeleted: (embeds) => `Вставленная картинка сохранена, но её место в заметке было удалено: ${embeds}`,
    details: (path) => `. Подробности: ${path}`,
    stopped: 'Остановлено. ',
    migrated: (legacyId) => `Image Optimizer: установлена прежняя версия плагина (папка ${legacyId}); её настройки, если были, перенесены. ` +
      'Удалите ту версию в разделе «Сторонние плагины»: если включены обе, каждая вставка обрабатывается дважды.',
  },
  menu: {
    optimizeFolder: 'Сжать картинки в этой папке',
  },
  placeholder: 'Сжатие картинки',
  progress: {
    title: 'Сжатие картинок в хранилище',
    folderTitle: (folder) => `Сжатие картинок в папке ${folder}`,
    stop: 'Остановить',
    note: (n, total, summary) => `Заметка ${n} из ${total}: ${summary}`,
  },
  summary: (s) => {
    const parts = [`${plural(s.converted, 'сжата', 'сжаты', 'сжато')} ${s.converted} ${plural(s.converted, 'картинка', 'картинки', 'картинок')}`];
    if (s.before) parts.push(`${s.before} → ${s.after}`);
    if (s.kept) parts.push(`${s.kept} ${plural(s.kept, 'оставлена', 'оставлены', 'оставлено')} как есть`);
    if (s.failed) parts.push(`${s.failed} с ошибкой`);
    return parts.join(', ');
  },
  folderError: (error) => {
    switch (error.kind) {
      case 'dots': return 'В пути к папке не должно быть «.» и «..».';
      case 'hidden': return `Скрытые папки Obsidian не показывает: «${error.segment}».`;
      case 'forbidden': return `В имени папки есть символ, который Obsidian не разрешает: «${error.segment}».`;
    }
  },
  settings: {
    language: {
      name: 'Язык',
      desc: 'Язык плагина. «Как в Obsidian» — язык интерфейса Obsidian, а если такого языка в плагине нет, английский.',
      auto: 'Как в Obsidian',
    },
    folder: {
      name: 'Папка для картинок',
      desc: 'Куда сохраняются скачанные и вставленные картинки. «Attachments» — папка рядом с заметкой, ' +
        '«/Attachments» — одна папка в корне хранилища, пустое значение — папка самой заметки. ' +
        'Настройки плагина лежат в .obsidian/plugins: если синхронизация не переносит эту папку, задайте настройку на каждом устройстве.',
    },
    quality: {
      name: 'Качество',
      desc: 'Качество WebP с потерями, 1–100. При 40 текст и фотографии выглядят так же, а весят в разы меньше. ' +
        'Скриншоты и записи экрана в PNG, BMP и GIF сжимаются без потерь, пиксель в пиксель.',
    },
    method: {
      name: 'Степень сжатия',
      desc: 'Метод libwebp. 4 — быстро; 6 даёт файлы примерно на 5% меньше, но в несколько раз медленнее, что заметно на телефонах.',
      default: '4 (по умолчанию)',
      smallest: '6 (меньше всего, медленно)',
    },
    minSavings: {
      name: 'Минимальная экономия, %',
      desc: 'Оригинал остаётся, если WebP меньше него менее чем на столько процентов.',
    },
    gif: {
      name: 'GIF',
      desc: 'Анимированные GIF превращаются в анимированный WebP; «Оставлять GIF» не трогает ни один GIF.',
      convert: 'Сжимать в WebP',
      keep: 'Оставлять GIF',
    },
    convertLocal: {
      name: 'Сжимать картинки, уже лежащие в хранилище',
      desc: 'Команды сжимают и локальные JPG, PNG, BMP и GIF, а оригиналы перемещают в корзину хранилища (.trash).',
    },
    autoOnPaste: {
      name: 'Сжимать при вставке и перетаскивании',
      desc: 'Вставленные и перетащенные картинки, а также картинки по ссылкам во вставленном тексте сжимаются сразу.',
    },
    reuseIdentical: {
      name: 'Не сохранять одинаковые файлы',
      desc: 'В имя сохранённого файла добавляется короткий отпечаток оригинала (photo-3fa9c2e1b7d04a85.webp). Картинка, ' +
        'добавленная повторно — в другой заметке, вставленная дважды или на другом устройстве после синхронизации, — ' +
        'ссылается на этот файл, даже если настройки менялись. Выкл.: без отпечатка, каждая картинка сохраняется новым ' +
        'файлом. Существующие файлы никогда не изменяются.',
    },
    limits: 'Ограничения',
    maxDownload: {
      name: 'Максимальный размер загрузки, МБ',
      desc: 'Файлы больше не скачиваются.',
    },
    maxMegapixels: {
      name: 'Максимальный размер картинки, мегапикселей',
      desc: 'Картинки больше (для GIF: ширина × высота × кадры) остаются как есть, чтобы не исчерпать память телефона.',
    },
    allowPrivateHosts: {
      name: 'Разрешить адреса локальной сети',
      desc: 'Разрешить скачивание с localhost и адресов локальной сети, указанных в ссылках.',
    },
    writeLogNote: {
      name: 'Вести журнал в заметке',
      desc: 'Дописывать подробности каждого запуска в image-optimizer-log.md для поиска проблем. Журнал ведётся на английском.',
    },
  },
};

const STRINGS: Record<Language, Strings> = { en, ru };

/** Names of the languages, each in its own language, for the language setting. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', ru: 'Русский' };

// resolveLanguage picks the plugin language: the setting, or for "auto" the
// Obsidian interface language ("ru", "en-GB", …), English when the plugin
// does not have it.
export function resolveLanguage(setting: LanguageSetting, appLanguage: string | null | undefined): Language {
  if (setting !== 'auto') return setting;
  const base = (appLanguage ?? '').toLowerCase().split(/[-_]/)[0];
  return base in STRINGS ? base as Language : 'en';
}

export function stringsFor(language: Language): Strings {
  return STRINGS[language];
}

// plural picks the Russian form for 1, 2–4 and 5+ (21 is like 1, 12 like 5).
function plural(n: number, one: string, few: string, many: string): string {
  const tens = n % 100;
  const units = n % 10;
  if (units === 1 && tens !== 11) return one;
  if (units >= 2 && units <= 4 && (tens < 12 || tens > 14)) return few;
  return many;
}
