export const formatNumber = (value, digits = 0) =>
    new Intl.NumberFormat(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Number(value || 0))
export const formatPercent = (value) => `${(Number(value || 0) * 100).toFixed(0)}%`
export const formatCost = (value) => `$${Number(value || 0).toFixed(4)}`
export const formatDuration = (value) => {
    const ms = Number(value || 0)
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}
export const formatRatio = (ratio) => (ratio === null || ratio === undefined ? '—' : `×${Number(ratio).toFixed(2)}`)
export const formatDate = (value) => (value ? new Date(value).toLocaleString() : '—')

export const TOOL_MODE_LABELS = {
    simulated: 'simulated tools',
    real: 'real tools',
    mixed: 'mixed tools',
    none: 'no tools'
}
