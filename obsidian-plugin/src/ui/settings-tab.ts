import { type App, type Plugin, PluginSettingTab, Setting } from 'obsidian';
import { normalizeFolder, validateFolder } from '../domain/folders.ts';
import { LIMITS, type GifMode, type PluginSettings } from '../settings.ts';

export interface SettingsHost extends Plugin {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
}

export class ImageOptimizerSettingTab extends PluginSettingTab {
  private readonly host: SettingsHost;

  constructor(app: App, host: SettingsHost) {
    super(app, host);
    this.host = host;
  }

  display(): void {
    const { containerEl } = this;
    const s = this.host.settings;
    containerEl.empty();

    const folder = new Setting(containerEl)
      .setName('Image folder')
      .setDesc('Where downloaded and pasted images are saved. "Attachments" is a folder next to the note, ' +
        '"/Attachments" is one folder at the vault root, an empty value is the note\'s own folder. ' +
        'Plugin settings live in .obsidian/plugins: if your sync does not copy that folder, set this on every device.');
    const folderError = containerEl.createDiv({ cls: 'mod-warning' });
    folder.addText((text) => text
      .setPlaceholder('Attachments')
      .setValue(s.folder)
      .onChange(async (value) => {
        const error = validateFolder(value);
        folderError.setText(error ?? '');
        if (error) return;
        s.folder = normalizeFolder(value);
        await this.host.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Quality')
      .setDesc('WebP quality, 1–100. 40 keeps text and photos visually unchanged at a fraction of the size.')
      .addSlider((slider) => slider
        .setLimits(LIMITS.quality[0], LIMITS.quality[1], 1)
        .setValue(s.quality)
        .setDynamicTooltip()
        .onChange(async (value) => { s.quality = value; await this.host.saveSettings(); }));

    new Setting(containerEl)
      .setName('Compression effort')
      .setDesc('libwebp method. 4 is fast; 6 makes files about 5% smaller but is several times slower, noticeable on phones.')
      .addDropdown((dropdown) => {
        for (let m: number = LIMITS.method[0]; m <= LIMITS.method[1]; m++) {
          dropdown.addOption(String(m), m === 4 ? '4 (default)' : m === 6 ? '6 (smallest, slow)' : String(m));
        }
        dropdown.setValue(String(s.method)).onChange(async (value) => {
          s.method = Number(value);
          await this.host.saveSettings();
        });
      });

    this.number(containerEl, 'Minimum saving, %',
      'Keep the original unless the WebP is at least this much smaller.', 'minSavingsPercent');

    new Setting(containerEl)
      .setName('GIF')
      .setDesc('Animated GIFs become animated WebP; "keep" leaves every GIF as it is.')
      .addDropdown((dropdown) => dropdown
        .addOption('animated-webp', 'Convert to WebP')
        .addOption('keep', 'Keep GIF')
        .setValue(s.gifMode)
        .onChange(async (value) => { s.gifMode = value as GifMode; await this.host.saveSettings(); }));

    this.toggle(containerEl, 'Convert images already in the vault',
      'Commands also convert local JPG, PNG, BMP and GIF images and move the originals to the vault trash (.trash).',
      'convertLocal');
    this.toggle(containerEl, 'Convert on paste and drop',
      'Pasted or dropped images, and web images in pasted text, are converted right away.', 'autoOnPaste');
    this.toggle(containerEl, 'Reuse identical files',
      'If a file of the same name (pic.webp, pic-1.webp, …) in the target folder holds exactly the same bytes, ' +
      'link to it instead of saving a copy. Existing files are never changed.', 'reuseIdentical');

    new Setting(containerEl).setName('Limits').setHeading();
    this.number(containerEl, 'Maximum download, MB', 'Larger downloads are refused.', 'maxDownloadMB');
    this.number(containerEl, 'Maximum image size, megapixels',
      'Larger images (for GIFs: width × height × frames) are kept as they are, to protect memory on phones.',
      'maxMegapixels');
    this.toggle(containerEl, 'Allow private network addresses',
      'Allow downloads from localhost and local network addresses written in links.', 'allowPrivateHosts');
    this.toggle(containerEl, 'Write a log note',
      'Append details of every run to image-optimizer-log.md, for troubleshooting.', 'writeLogNote');
  }

  private toggle(el: HTMLElement, name: string, desc: string, key: BooleanKey): void {
    new Setting(el).setName(name).setDesc(desc).addToggle((toggle) => toggle
      .setValue(this.host.settings[key])
      .onChange(async (value) => { this.host.settings[key] = value; await this.host.saveSettings(); }));
  }

  private number(el: HTMLElement, name: string, desc: string, key: NumberKey): void {
    const [min, max] = LIMITS[key];
    new Setting(el).setName(name).setDesc(`${desc} (${min}–${max})`).addText((text) => {
      text.inputEl.type = 'number';
      text.setValue(String(this.host.settings[key])).onChange(async (value) => {
        const number = Number(value);
        if (!Number.isInteger(number) || number < min || number > max) return;
        this.host.settings[key] = number;
        await this.host.saveSettings();
      });
    });
  }
}

type BooleanKey = { [K in keyof PluginSettings]: PluginSettings[K] extends boolean ? K : never }[keyof PluginSettings];
type NumberKey = keyof typeof LIMITS & { [K in keyof PluginSettings]: PluginSettings[K] extends number ? K : never }[keyof PluginSettings];
