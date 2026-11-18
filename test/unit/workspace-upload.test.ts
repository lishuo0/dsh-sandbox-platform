import { describe, expect, it } from 'vitest'
import { safeUploadName, splitFileName, uploadCandidate } from '../../src/modules/workspaces/upload.js'

describe('工作区上传的文件名', () => {
  it('拆出扩展名，点文件整体算主名', () => {
    expect(splitFileName('report.pdf')).toEqual({ stem: 'report', extension: '.pdf' })
    expect(splitFileName('archive.tar.gz')).toEqual({ stem: 'archive.tar', extension: '.gz' })
    expect(splitFileName('.env')).toEqual({ stem: '.env', extension: '' })
    expect(splitFileName('README')).toEqual({ stem: 'README', extension: '' })
  })

  it('重名按 name (n).ext 顺延', () => {
    expect(uploadCandidate('report.pdf', 0)).toBe('report.pdf')
    expect(uploadCandidate('report.pdf', 1)).toBe('report (1).pdf')
    expect(uploadCandidate('report.pdf', 12)).toBe('report (12).pdf')
    expect(uploadCandidate('.env', 2)).toBe('.env (2)')
    expect(uploadCandidate('README', 3)).toBe('README (3)')
  })

  it('只接受纯文件名', () => {
    expect(safeUploadName('  报告.docx ')).toBe('报告.docx')
    expect(safeUploadName('a b.txt')).toBe('a b.txt')
    expect(safeUploadName('')).toBeUndefined()
    expect(safeUploadName('   ')).toBeUndefined()
    expect(safeUploadName('.')).toBeUndefined()
    expect(safeUploadName('..')).toBeUndefined()
    expect(safeUploadName('../escape.txt')).toBeUndefined()
    expect(safeUploadName('dir/name.txt')).toBeUndefined()
    expect(safeUploadName('dir\\name.txt')).toBeUndefined()
    expect(safeUploadName('bad\0name')).toBeUndefined()
    expect(safeUploadName('x'.repeat(256))).toBeUndefined()
    expect(safeUploadName('x'.repeat(255))).toBe('x'.repeat(255))
  })
})
