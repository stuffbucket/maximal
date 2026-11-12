// Stays alive until something ends it: the process the containment test
// expects Windows to kill along with the broker.
setInterval(() => undefined, 60_000)
