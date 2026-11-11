/**
 * Valida el :workspaceId de /api/workspaces/... antes de que se use para armar rutas de disco.
 * Solo letras, números, guion y guion bajo: así "../" (o "..%2F") no puede salir de uploads/.
 */
const VALID_WORKSPACE = /^[A-Za-z0-9_-]{1,64}$/;

function checkWorkspace(req, res, next) {
  if (!VALID_WORKSPACE.test(req.params.workspaceId || '')) {
    return res.status(400).json({ error: 'Espacio de trabajo no valido' });
  }
  return next();
}

module.exports = { checkWorkspace, VALID_WORKSPACE };
