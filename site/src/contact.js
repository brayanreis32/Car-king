import { initChrome } from './lib.js'

const topic = new URLSearchParams(location.search).get('topic')
const sel = document.querySelector('select[name=topic]')
if (topic && sel && [...sel.options].some((o) => o.value === topic)) sel.value = topic
initChrome('contact')
