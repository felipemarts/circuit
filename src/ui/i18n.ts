/**
 * Minimal UI localization for the simulator shell. English strings are the
 * keys; the Portuguese page (`<html lang="pt-BR">`) gets the translation.
 */

const PT: Record<string, string> = {
  'Select a component to edit its name, value and rotation.': 'Selecione um componente para editar nome, valor e rotação.',
  'Results': 'Resultados',
  'Play': 'Play',
  'Pause': 'Pausar',
  'Simulating…': 'Simulando…',
  'Paused': 'Pausado',
  'Ready': 'Pronto',
  'No components in the circuit': 'Nenhum componente no circuito',
  'Add at least one GND': 'Adicione pelo menos um GND',
  'Error running code': 'Erro ao executar o código',
  'Code executed': 'Código executado',
  'components': 'componentes',
  'transient': 'transitório',
  'points': 'pontos',
  'RLC demo loaded — press Play to simulate': 'Demo RLC carregada — aperte Play para simular',
  'Drag to move · pin→pin to connect · R or right-click to rotate': 'Arraste para mover · pino→pino para ligar · R ou botão direito para girar',
  'Click a pin to start a wire': 'Clique num pino para começar um fio',
  'Click a pin to add/remove a probe': 'Clique num pino para adicionar/remover uma sonda',
  'Click the canvas to place': 'Clique no canvas para posicionar',
  'click another pin': 'clique em outro pino',
  'Type': 'Tipo',
  'Name': 'Nome',
  'Value': 'Valor',
  'AC amplitude (V)': 'Amplitude AC (V)',
  'Frequency (Hz)': 'Frequência (Hz)',
  'Rotation (degrees)': 'Rotação (graus)',
  'Delete component': 'Apagar componente',
  'Simulation error': 'Erro na simulação',
  'Error': 'Erro',
  // project manager
  'Create a new project? Unsaved changes will be lost.': 'Criar um novo projeto? Alterações não salvas serão perdidas.',
  'Save project': 'Salvar projeto',
  'Save as': 'Salvar como',
  'Project name': 'Nome do projeto',
  'No saved projects.': 'Nenhum projeto salvo.',
  'Open project': 'Abrir projeto',
  'Examples': 'Exemplos',
  'Open': 'Abrir',
  'Delete': 'Apagar',
  'Load': 'Carregar',
  'Delete project': 'Apagar o projeto',
  // code editor
  'Rename file:': 'Renomear arquivo:',
  'File name:': 'Nome do arquivo:',
  'New file': 'Novo arquivo',
  'Delete file': 'Apagar o arquivo',
};

const isPT = typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('pt');

export function t(key: string): string {
  return isPT ? (PT[key] ?? key) : key;
}
