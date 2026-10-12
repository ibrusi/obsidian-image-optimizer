import { type App, type Plugin, PluginSettingTab, Setting } from 'obsidian';
import { normalizeFolder, validateFolder } from '../domain/folders.ts';
import { LANGUAGE_NAMES, type Language, type LanguageSetting, type Strings } from '../i18n.ts';
import { LIMITS, type GifMode, type PluginSettings } from '../settings.ts';

export interface SettingsHost extends Plugin {
  settings: PluginSettings;
  readonly strings: Strings;
  saveSettings(): Promise<void>;
  /** Applies a changed language setting to the commands and this tab. */
  applyLanguage(): void;
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

    const t = this.host.strings.settings;

    new Setting(containerEl)
      .setName(t.language.name)
      .setDesc(t.language.desc)
      .addDropdown((dropdown) => {
        dropdown.addOption('auto', t.language.auto);
        for (const [code, name] of Object.entries(LANGUAGE_NAMES) as Array<[Language, string]>) dropdown.addOption(code, name);
        dropdown.setValue(s.language).onChange(async (value) => {
          s.language = value as LanguageSetting;
          await this.host.saveSettings();
          this.host.applyLanguage();
          this.display();
        });
      });

    const folder = new Setting(containerEl)
      .setName(t.folder.name)
      .setDesc(t.folder.desc);
    const folderError = containerEl.createDiv({ cls: 'mod-warning' });
    folder.addText((text) => text
      .setPlaceholder('Attachments')
      .setValue(s.folder)
      .onChange(async (value) => {
        const error = validateFolder(value);
        folderError.setText(error ? this.host.strings.folderError(error) : '');
        if (error) return;
        s.folder = normalizeFolder(value);
        await this.host.saveSettings();
      }));

    new Setting(containerEl)
      .setName(t.quality.name)
      .setDesc(t.quality.desc)
      .addSlider((slider) => slider
        .setLimits(LIMITS.quality[0], LIMITS.quality[1], 1)
        .setValue(s.quality)
        .setDynamicTooltip()
        .onChange(async (value) => { s.quality = value; await this.host.saveSettings(); }));

    new Setting(containerEl)
      .setName(t.method.name)
      .setDesc(t.method.desc)
      .addDropdown((dropdown) => {
        for (let m: number = LIMITS.method[0]; m <= LIMITS.method[1]; m++) {
          dropdown.addOption(String(m), m === 4 ? t.method.default : m === 6 ? t.method.smallest : String(m));
        }
        dropdown.setValue(String(s.method)).onChange(async (value) => {
          s.method = Number(value);
          await this.host.saveSettings();
        });
      });

    this.number(containerEl, t.minSavings, 'minSavingsPercent');

    new Setting(containerEl)
      .setName(t.gif.name)
      .setDesc(t.gif.desc)
      .addDropdown((dropdown) => dropdown
        .addOption('animated-webp', t.gif.convert)
        .addOption('keep', t.gif.keep)
        .setValue(s.gifMode)
        .onChange(async (value) => { s.gifMode = value as GifMode; await this.host.saveSettings(); }));

    this.toggle(containerEl, t.convertLocal, 'convertLocal');
    this.toggle(containerEl, t.autoOnPaste, 'autoOnPaste');
    this.toggle(containerEl, t.reuseIdentical, 'reuseIdentical');

    new Setting(containerEl).setName(t.limits).setHeading();
    this.number(containerEl, t.maxDownload, 'maxDownloadMB');
    this.number(containerEl, t.maxMegapixels, 'maxMegapixels');
    this.toggle(containerEl, t.allowPrivateHosts, 'allowPrivateHosts');
    this.toggle(containerEl, t.writeLogNote, 'writeLogNote');
  }

  private toggle(el: HTMLElement, text: Text, key: BooleanKey): void {
    new Setting(el).setName(text.name).setDesc(text.desc).addToggle((toggle) => toggle
      .setValue(this.host.settings[key])
      .onChange(async (value) => { this.host.settings[key] = value; await this.host.saveSettings(); }));
  }

  private number(el: HTMLElement, text: Text, key: NumberKey): void {
    const [min, max] = LIMITS[key];
    new Setting(el).setName(text.name).setDesc(`${text.desc} (${min}–${max})`).addText((text) => {
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

interface Text {
  name: string;
  desc: string;
}

type BooleanKey = { [K in keyof PluginSettings]: PluginSettings[K] extends boolean ? K : never }[keyof PluginSettings];
type NumberKey = keyof typeof LIMITS & { [K in keyof PluginSettings]: PluginSettings[K] extends number ? K : never }[keyof PluginSettings];
