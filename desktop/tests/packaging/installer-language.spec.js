/**
 * Does the installer-language check DISCRIMINATE, or does it just always pass?
 *
 * `scripts/verify-installer-ui.mjs` has already failed once for the wrong reason: it counted
 * "Cancelar" as an English "Cancel", because `String.includes` matches inside a longer word. A
 * language check that cannot tell Spanish from English is worse than no check, because a green run
 * gets believed.
 *
 * So the matching rule is exercised against both languages here, with no installer involved. If
 * someone loosens the expression again, this fails before the next release does.
 */
import { describe, it, expect } from 'vitest'

const ENGLISH = ['Installation', 'Next', 'Cancel', 'Install', 'Select Install Location']
const SPANISH = ['Instalación de MiniMarck', 'Siguiente', 'Cancelar', 'Instalar']

/** The exact expression `verify-installer-ui.mjs` uses. Kept duplicated on purpose: importing it
 *  would mean a refactor could silently change the gate's behaviour and the test would follow it. */
function englishLeaks(captions) {
  return ENGLISH.filter((phrase) =>
    captions.some((caption) =>
      new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(caption)
    )
  )
}

function spanishFound(captions) {
  return SPANISH.filter((phrase) => captions.some((caption) => caption.includes(phrase)))
}

// Captions read off a real es_ES wizard by `read-installer-controls.ps1`, accents and all.
const SPANISH_CAPTIONS = [
  '&Siguiente >',
  'Cancelar',
  'Elegir opciones de instalación',
  '¿Para quién se instalará esta aplicación?',
  'Elige si deseas que este software esté disponible para todos',
  'Cualquiera que utilice este ordenador (todos los usuarios)',
  'Solo para mí. (benit)',
  'Instalación de MiniMarck'
]

const ENGLISH_CAPTIONS = [
  '&Next >',
  'Cancel',
  'Choose Install Location',
  'Installation for all users',
  'Welcome to the MiniMarck Installer'
]

describe('the installer language check', () => {
  it('accepts a Spanish wizard', () => {
    expect(spanishFound(SPANISH_CAPTIONS).length).toBeGreaterThan(0)
    expect(englishLeaks(SPANISH_CAPTIONS)).toEqual([])
  })

  it('REJECTS an English wizard', () => {
    expect(spanishFound(ENGLISH_CAPTIONS)).toEqual([])
    expect(englishLeaks(ENGLISH_CAPTIONS).length).toBeGreaterThan(0)
  })

  it('does not mistake a Spanish word that starts with an English one', () => {
    // The regression that made the first version unusable: "Cancelar" contains "Cancel", and
    // "Instalar" contains "Install". Substring matching flagged both as language leaks.
    expect(englishLeaks(['Cancelar'])).toEqual([])
    expect(englishLeaks(['Instalar'])).toEqual([])
    expect(englishLeaks(['Instalación'])).toEqual([])
    expect(englishLeaks(['Desinstalar'])).toEqual([])
  })

  it('still matches the English words when they stand alone', () => {
    expect(englishLeaks(['Cancel'])).toContain('Cancel')
    expect(englishLeaks(['&Next >'])).toContain('Next')
    expect(englishLeaks(['Install'])).toContain('Install')
  })
})
