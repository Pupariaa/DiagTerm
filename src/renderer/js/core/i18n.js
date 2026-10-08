import { FR } from './lang-fr.js';
import { getSetting } from './settings.js';

const DICTIONARIES = { fr: FR };

export function t(text, vars) {
    const lang = getSetting('general.language', 'en');
    const dict = DICTIONARIES[lang];
    let out = dict && dict[text] ? dict[text] : text;
    if (vars) {
        for (const [key, value] of Object.entries(vars)) out = out.split(`{${key}}`).join(String(value));
    }
    return out;
}

export function currentLanguage() {
    return getSetting('general.language', 'en');
}
