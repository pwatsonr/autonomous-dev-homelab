/**
 * Sample Docker CLI output fixtures for DockerSwarmEnumerator tests.
 *
 * All names and IDs here are synthetic test values; no real homelab node or
 * service names are hard-coded in production code (invariant #62). Fixtures
 * are the only place that may reference concrete names, and only for test
 * assertion purposes.
 */

/** Sample `docker node ls --format '{{json .}}'` output (two nodes). */
export const FIXTURE_NODE_LS = `
{"ID":"node1abc","Hostname":"worker-01","Status":"Ready","Availability":"Active","ManagerStatus":"","EngineVersion":"24.0.5"}
{"ID":"node2abc","Hostname":"manager-01","Status":"Ready","Availability":"Active","ManagerStatus":"Leader","EngineVersion":"24.0.5"}
`.trim();

/** Sample `docker service ls --format '{{json .}}'` output (two services). */
export const FIXTURE_SERVICE_LS = `
{"ID":"svc1abc","Name":"web-frontend","Mode":"Replicated","Replicas":"3/3","Image":"nginx:alpine","Ports":"*:80->80/tcp, *:443->443/tcp"}
{"ID":"svc2abc","Name":"api-backend","Mode":"Replicated","Replicas":"2/2","Image":"node:18","Ports":"*:3000->3000/tcp"}
`.trim();

/** Sample `docker service ps --format '{{json .}}'` output (running tasks). */
export const FIXTURE_SERVICE_PS = `
{"ID":"task1abc","Name":"web-frontend.1.task1abc","Image":"nginx:alpine","Node":"worker-01","DesiredState":"Running","CurrentState":"Running 2 days ago"}
{"ID":"task2abc","Name":"web-frontend.2.task2abc","Image":"nginx:alpine","Node":"manager-01","DesiredState":"Running","CurrentState":"Running 2 days ago"}
{"ID":"task3abc","Name":"api-backend.1.task3abc","Image":"node:18","Node":"worker-01","DesiredState":"Running","CurrentState":"Running 1 day ago"}
{"ID":"task4abc","Name":"web-frontend.3.task4abc","Image":"nginx:alpine","Node":"worker-01","DesiredState":"Shutdown","CurrentState":"Shutdown 1 hour ago"}
`.trim();

/** Sample `docker network ls --format '{{json .}}'` output. */
export const FIXTURE_NETWORK_LS = `
{"ID":"net1abc","Name":"ingress","Driver":"overlay","Scope":"swarm","Labels":""}
{"ID":"net2abc","Name":"app-network","Driver":"overlay","Scope":"swarm","Labels":"com.docker.stack.namespace=myapp"}
{"ID":"net3abc","Name":"bridge","Driver":"bridge","Scope":"local","Labels":""}
{"ID":"net4abc","Name":"host","Driver":"host","Scope":"host","Labels":""}
`.trim();

/** Sample output with no nodes (empty swarm). */
export const FIXTURE_NODE_LS_EMPTY = '';

/** Sample output where service ps has a command failure. */
export const FIXTURE_SERVICE_PS_EMPTY = '';
