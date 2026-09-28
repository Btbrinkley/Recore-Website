const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/sentinel-chart.js'),'utf8');
const ctx=vm.createContext({document:{activeElement:null}});
vm.runInContext(source+'\nthis.chart=SentinelChart;',ctx);
function render(readings){const container={dataset:{},innerHTML:'',querySelector:()=>null};ctx.chart.render(container,readings,'node001:24h');return container.innerHTML;}
const point={recordedAt:'2026-09-28T12:00:00Z',voltage:12.4,rssi:-60,sequence:1};
for(const [internal,external] of [[null,null],[75,null],[null,0],[75,68]]){
 const html=render([{...point,internalTemperatureF:internal,externalTemperatureF:external}]);
 assert.equal(html.includes('data-series="tempF"'),internal!==null);
 assert.equal(html.includes('data-series="externalTempF"'),external!==null);
 assert.ok(html.includes('data-series="rssi"'));
 assert.ok(!html.includes('NaN'));
}
const gap=render([{...point,externalTemperatureF:60},{...point,recordedAt:'2026-09-28T12:01:00Z',externalTemperatureF:null},{...point,recordedAt:'2026-09-28T12:02:00Z',externalTemperatureF:70}]);
assert.equal((gap.match(/data-series="externalTempF" d="([^"]+)"/)[1].match(/M/g)||[]).length,2);
assert.ok(gap.includes('External probe: unavailable'));
assert.ok(render([]).includes('Collecting history'));
assert.equal(ctx.chart.normalizeReadings([{...point,recordedAt:'bad'}]).length,0);
const normalized=ctx.chart.normalizeReadings([{...point,recordedAt:'2026-09-28T12:02:00Z'},point]);
assert.equal(normalized[0].recordedAt,point.recordedAt);
assert.equal(ctx.chart.normalizeReadings([{...point,temperatureF:72}])[0].tempF,72);
assert.equal(ctx.chart.normalizeReadings([{...point,temperatureF:72,internalTemperatureF:null}])[0].tempF,null);
console.log('PASS: conditional temperatures, zero, signal, sensor gaps, empty data, legacy values, chronological ordering, and original timestamps.');
