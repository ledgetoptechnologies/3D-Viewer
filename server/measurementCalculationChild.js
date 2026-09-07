'use strict';
// The existing worker forks this bounded child; no network listener or separate
// service/container is created. Paths arrive only over the parent IPC channel.
process.once('message', async ({ absolutePath, request, maxCells, memoryMiB, sourceFiles, scratchRoot }) => {
  const controller = new AbortController();
  for(const event of ['SIGTERM','SIGINT','disconnect'])process.once(event,()=>controller.abort());
  const memory = setInterval(() => process.send?.({ type: 'memory', rss: process.memoryUsage().rss }), 1000); memory.unref();
  try {
    let result;
    if (request.method === 'closed-mesh') {
      const { calculateClosedObj } = await import('./measurementMeshCalculation.mjs');
      result = await calculateClosedObj(absolutePath, request, { signal: controller.signal });
    } else if (request.method === 'reconstructed-estimate') {
      const { reconstructSelectedObj, reconstructSelectedEpt } = await import('./measurementReconstruction.mjs');
      result = await (request.source.kind==='ept'?reconstructSelectedEpt:reconstructSelectedObj)(absolutePath, request, { signal: controller.signal, scratchRoot, sourceFiles, memoryMiB });
    } else if (request.method === 'point-surface-cut-fill') {
      const { calculatePointSurface } = await import('./measurementPointSurface.mjs');
      result = await calculatePointSurface(absolutePath, request, { maxCells, sourceFiles, signal: controller.signal });
    } else if(request.method==='surface-transect'){
      const {calculateNativeRasterTransect}=await import('./measurementRasterTransect.mjs');
      result=await calculateNativeRasterTransect(absolutePath,request,{maxCells, maxBlockBytes:Math.min(256,(memoryMiB||4096)/8)*1024*1024,signal:controller.signal});
    } else if (request.method === 'surface-cut-fill') {
      const { calculateNativeRaster } = await import('./measurementRasterCalculation.mjs');
      result = await calculateNativeRaster(absolutePath, request, { maxCells, maxBlockBytes: Math.min(256, (memoryMiB || 4096) / 8) * 1024 * 1024, signal: controller.signal });
    } else throw Object.assign(new Error('unsupported measurement method'), { code: 'measurement_method_unavailable' });
    process.send?.({ type: 'result', result });
  } catch (error) { process.send?.({ type: 'error', code: /^[a-z][a-z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'measurement_calculation_failed' }); }
  finally { clearInterval(memory); process.disconnect?.(); }
});
