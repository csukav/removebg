import { removeBackground as imglyRemoveBackground } from '@imgly/background-removal'
import JSZip from 'jszip'

import './style.css'

type JobStatus = 'pending' | 'processing' | 'ready' | 'error'

interface RemovalJob {
  id: string
  file: File
  status: JobStatus
  previewUrl: string
  resultUrl?: string
  resultBlob?: Blob
  error?: string
}

const MAX_FILE_SIZE_MB = 12
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024
const MAX_PARALLEL_JOBS = 2

const statusLabels: Record<JobStatus, string> = {
  pending: 'Várólistán',
  processing: 'Feldolgozás alatt',
  ready: 'Kész',
  error: 'Hiba',
}

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('Az alkalmazás gyökéreleme nem található.')
}

app.innerHTML = `
  <main class="page">
    <header class="hero">
      <div>
        <p class="badge">AI Studio</p>
        <h1>Háttér eltávolítás több képen egyszerre</h1>
        <p class="lede">
          Dobd be a képeidet, és hagyd hogy az AI megtisztítsa őket a felesleges háttértől.
        </p>
      </div>
      <div class="hero__cta">
        <button id="select-files" class="btn primary" type="button">Képek kiválasztása</button>
        <p class="subtext">JPG, PNG vagy WEBP · max ${MAX_FILE_SIZE_MB} MB fájlonként</p>
      </div>
    </header>

    <section class="uploader" id="drop-zone">
      <input id="file-input" type="file" accept="image/*" multiple hidden />
      <div class="uploader__hint">
        <p class="hint-title">Húzd ide a képeket</p>
        <p class="hint-copy">vagy kattints a gombra a feltöltéshez</p>
      </div>
    </section>

    <section class="summary" aria-live="polite">
      <div>
        <p class="summary__label">Várólista</p>
        <p class="summary__value" id="summary-active">0</p>
      </div>
      <div>
        <p class="summary__label">Kész</p>
        <p class="summary__value" id="summary-done">0</p>
      </div>
      <div>
        <p class="summary__label">Hibás</p>
        <p class="summary__value" id="summary-error">0</p>
      </div>
    </section>

    <section class="batch-control">
      <button id="download-all" class="btn ghost" type="button" disabled>
        Összes kész kép letöltése (.zip)
      </button>
    </section>

    <section class="queue" id="job-list">
      <p class="empty">Még nem adtál hozzá képet.</p>
    </section>
  </main>
`

const liveRegion = document.createElement('p')
liveRegion.className = 'sr-only'
liveRegion.setAttribute('aria-live', 'polite')
app.appendChild(liveRegion)

const announce = (message: string) => {
  liveRegion.textContent = message
}

const fileInput = document.querySelector<HTMLInputElement>('#file-input')
const selectButton = document.querySelector<HTMLButtonElement>('#select-files')
const dropZone = document.querySelector<HTMLDivElement>('#drop-zone')
const jobList = document.querySelector<HTMLDivElement>('#job-list')
const summaryActive = document.querySelector<HTMLParagraphElement>('#summary-active')
const summaryDone = document.querySelector<HTMLParagraphElement>('#summary-done')
const summaryError = document.querySelector<HTMLParagraphElement>('#summary-error')
const downloadAllButton = document.querySelector<HTMLButtonElement>('#download-all')

if (
  !fileInput ||
  !selectButton ||
  !dropZone ||
  !jobList ||
  !summaryActive ||
  !summaryDone ||
  !summaryError ||
  !downloadAllButton
) {
  throw new Error('Hiányzó feltöltő komponens. Ellenőrizd a markupot.')
}

const jobs = new Map<string, RemovalJob>()

let readyJobCount = 0

const escapeHtml = (input: string) =>
  input.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char] ?? char))

const formatMegabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

const cleanupJobUrls = (job: RemovalJob) => {
  URL.revokeObjectURL(job.previewUrl)
  if (job.resultUrl && job.resultUrl.startsWith('blob:')) {
    URL.revokeObjectURL(job.resultUrl)
  }
  job.resultBlob = undefined
}

const updateSummary = () => {
  const values = Array.from(jobs.values())
  summaryActive.textContent = String(values.filter((job) => job.status === 'pending' || job.status === 'processing').length)
  readyJobCount = values.filter((job) => job.status === 'ready').length
  summaryDone.textContent = String(readyJobCount)
  summaryError.textContent = String(values.filter((job) => job.status === 'error').length)
  updateBatchDownloadState()
}

const updateBatchDownloadState = () => {
  downloadAllButton.disabled = readyJobCount === 0
}

const renderJobs = () => {
  if (jobs.size === 0) {
    jobList.innerHTML = '<p class="empty">Még nem adtál hozzá képet.</p>'
    return
  }

  const jobCards = Array.from(jobs.values())
    .reverse()
    .map((job) => {
      const jobName = escapeHtml(job.file.name)
      const jobError = job.error ? `<p class="job__error">${escapeHtml(job.error)}</p>` : ''
      const downloadDisabled = job.status === 'ready' ? '' : 'disabled'
      const removeDisabled = job.status === 'processing' ? 'disabled' : ''
      const retryHidden = job.status === 'error' ? '' : 'hidden'
      return `
        <article class="job" data-id="${job.id}">
          <div class="job__preview">
            <img src="${job.resultUrl ?? job.previewUrl}" alt="${jobName} előnézet" />
          </div>
          <div class="job__meta">
            <p class="job__name">${jobName}</p>
            <p class="job__size">${formatMegabytes(job.file.size)}</p>
            <p class="job__status job__status--${job.status}">${statusLabels[job.status]}</p>
            ${jobError}
          </div>
          <div class="job__actions">
            <button class="btn ghost" data-action="download" ${downloadDisabled}>Letöltés</button>
            <button class="btn ghost" data-action="retry" ${retryHidden}>Újra</button>
            <button class="btn ghost" data-action="remove" ${removeDisabled}>Eltávolítás</button>
          </div>
        </article>
      `
    })
    .join('')

  jobList.innerHTML = jobCards
}

const createJob = (file: File): RemovalJob => ({
  id: crypto.randomUUID(),
  file,
  status: 'pending',
  previewUrl: URL.createObjectURL(file),
})

const addFiles = (fileList: FileList | File[]) => {
  let added = 0
  let rejected = 0
  Array.from(fileList).forEach((file) => {
    if (!file.type.startsWith('image/')) {
      return
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      rejected += 1
      return
    }
    const job = createJob(file)
    jobs.set(job.id, job)
    added += 1
  })

  if (added > 0) {
    renderJobs()
    updateSummary()
    announce(`${added} új kép hozzáadva a feldolgozási sorhoz.`)
    startNextJobs()
  }
  if (rejected > 0) {
    announce(`${rejected} fájl meghaladta a ${MAX_FILE_SIZE_MB} MB limitet és kimaradt.`)
  }
}

selectButton.addEventListener('click', () => fileInput.click())

fileInput.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement
  if (target.files && target.files.length > 0) {
    addFiles(target.files)
    target.value = ''
  }
})

const toggleDropZoneState = (isActive: boolean) => {
  dropZone.dataset.active = String(isActive)
}

const dragEnterTypes = ['dragenter', 'dragover'] as const
dragEnterTypes.forEach((type) => {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault()
    toggleDropZoneState(true)
  })
})

const dragLeaveTypes = ['dragleave', 'drop'] as const
dragLeaveTypes.forEach((type) => {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault()
    if (type === 'drop') {
      const files = (event as DragEvent).dataTransfer?.files
      if (files && files.length > 0) {
        addFiles(files)
      }
    }
    toggleDropZoneState(false)
  })
})

jobList.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const button = target.closest<HTMLButtonElement>('button[data-action]')
  if (!button) return
  const card = button.closest<HTMLElement>('.job')
  if (!card) return
  const id = card.dataset.id
  if (!id) return

  const job = jobs.get(id)
  if (!job) return

  if (button.dataset.action === 'remove') {
    if (job.status === 'processing') {
      return
    }
    cleanupJobUrls(job)
    jobs.delete(id)
    renderJobs()
    updateSummary()
    announce(`${job.file.name} eltávolítva a sorból.`)
  }

  if (button.dataset.action === 'download') {
    if (job.status !== 'ready' || !job.resultUrl) return
    const link = document.createElement('a')
    link.href = job.resultUrl
    const baseName = job.file.name.replace(/\.[^.]+$/, '') || 'eltavolitott-hatter'
    link.download = `${baseName}-bg-removed.png`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  if (button.dataset.action === 'retry') {
    if (job.status !== 'error') return
    job.status = 'pending'
    job.error = undefined
    renderJobs()
    updateSummary()
    startNextJobs()
  }
})

downloadAllButton.addEventListener('click', () => {
  if (readyJobCount === 0) return
  void downloadAllReadyJobs()
})

let activeWorkers = 0

const startNextJobs = () => {
  while (activeWorkers < MAX_PARALLEL_JOBS) {
    const job = Array.from(jobs.values()).find((item) => item.status === 'pending')
    if (!job) break
    void runJob(job)
  }
}

const runJob = async (job: RemovalJob) => {
  activeWorkers += 1
  job.status = 'processing'
  job.error = undefined
  renderJobs()
  updateSummary()
  try {
    const blob = await performBackgroundRemoval(job.file)
    if (job.resultUrl && job.resultUrl.startsWith('blob:')) {
      URL.revokeObjectURL(job.resultUrl)
    }
    job.resultBlob = blob
    job.resultUrl = URL.createObjectURL(blob)
    job.status = 'ready'
    announce(`${job.file.name} feldolgozása befejeződött.`)
  } catch (error) {
    job.status = 'error'
    job.error = error instanceof Error ? error.message : 'Ismeretlen hiba történt.'
    announce(`${job.file.name} feldolgozása hibával leállt.`)
  } finally {
    renderJobs()
    updateSummary()
    activeWorkers = Math.max(0, activeWorkers - 1)
    startNextJobs()
  }
}

const performBackgroundRemoval = async (file: File): Promise<Blob> => {
  const blob = await imglyRemoveBackground(file, {
    model: 'isnet',
    output: {
      quality: 1,
      format: 'image/png',
    },
  })
  return blob
}

const downloadAllReadyJobs = async () => {
  if (readyJobCount === 0) return
  downloadAllButton.disabled = true
  downloadAllButton.dataset.busy = 'true'
  downloadAllButton.textContent = 'Összesítés folyamatban...'
  try {
    const readyJobs = Array.from(jobs.values()).filter((job) => job.status === 'ready' && (job.resultBlob || job.resultUrl))
    if (readyJobs.length === 0) {
      return
    }
    const zip = new JSZip()
    for (const job of readyJobs) {
      let blob = job.resultBlob
      if (!blob && job.resultUrl) {
        const response = await fetch(job.resultUrl)
        blob = await response.blob()
        job.resultBlob = blob
      }
      if (!blob) continue
      const baseName = job.file.name.replace(/\.[^.]+$/, '') || 'eltavolitott-hatter'
      zip.file(`${baseName}-bg-removed.png`, blob)
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' })
    const link = document.createElement('a')
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    link.download = `bg-removed-${timestamp}.zip`
    link.href = URL.createObjectURL(zipBlob)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    setTimeout(() => URL.revokeObjectURL(link.href), 5000)
    announce('Az összes elkészült kép letöltése megkezdődött.')
  } catch (error) {
    console.error(error)
    announce('A csomagolt letöltés nem sikerült, próbáld újra.')
  } finally {
    downloadAllButton.dataset.busy = 'false'
    downloadAllButton.textContent = 'Összes kész kép letöltése (.zip)'
    updateBatchDownloadState()
  }
}
