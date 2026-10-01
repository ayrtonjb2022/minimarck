/**
 * Commit subject BOM check, run after every commit.
 *
 * WHY THIS EXISTS. `b349433` shipped a commit whose subject began with a BOM
 * (EF BB BF) and it was missed twice, because PowerShell's pipe renders the bytes
 * as an invisible character: `git log --oneline` looks perfect and the terminal
 * shows a normal subject. The only reliable read is the RAW OBJECT BYTES.
 *
 * WHAT IT CHECKS. For each commit given (or HEAD):
 *   1. the message body does not start with EF BB BF,
 *   2. no line inside the subject contains EF BB BF either (a BOM can land
 *      mid-subject if a file was written with a trailing newline and appended to),
 *   3. there is no `Co-Authored-By` trailer, and no `-B` AI attribution line.
 *
 * Exits non-zero on any violation, so it can gate a commit pipeline.
 */
import { execFileSync } from 'node:child_process'

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

const shas = process.argv.slice(2)
const list = shas.length > 0 ? shas : [execFileSync('git', ['rev-parse', 'HEAD']).toString().trim()]

let fallos = 0
for (const sha of list) {
  const crudo = execFileSync('git', ['cat-file', 'commit', sha])
  // The object body starts after the first blank line; everything before it is headers.
  const separador = crudo.indexOf(Buffer.from('\n\n'))
  if (separador < 0) {
    console.log(`FAIL ${sha.slice(0, 7)}: no message body found`)
    fallos++
    continue
  }
  const mensaje = crudo.subarray(separador + 2)
  const lineas = mensaje.toString('utf8').split('\n')
  const asunto = lineas[0]

  const bomAlPrincipio = mensaje.subarray(0, 3).equals(BOM)
  const bomEnAsunto = asunto.includes('﻿')
  const coauthor = /co-authored-by/i.test(mensaje.toString('utf8'))
  const atribucionIA = /^\s*[-*]?\s*(generated with|claude|chatgpt|openai|copilot|co-authored)/im.test(mensaje.toString('utf8'))

  const problemas = []
  if (bomAlPrincipio) problemas.push('BOM at the start of the message')
  if (bomEnAsunto) problemas.push('BOM inside the subject')
  if (coauthor) problemas.push('Co-Authored-By trailer')
  if (atribucionIA) problemas.push('AI attribution')

  if (problemas.length > 0) {
    console.log(`FAIL ${sha.slice(0, 7)}: ${problemas.join('; ')}`)
    console.log(`     subject: ${JSON.stringify(asunto)}`)
    fallos++
  } else {
    console.log(`OK   ${sha.slice(0, 7)}  ${asunto.slice(0, 78)}`)
    console.log(`     first bytes of message: ${mensaje.subarray(0, 3).toString('hex').toUpperCase()} (no EF BB BF)`)
  }
}

process.exit(fallos === 0 ? 0 : 1)
