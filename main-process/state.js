/**
 * 🎯 S4E - Application State Management
 * 
 * Централизованное управление состоянием приложения.
 * Обеспечивает синхронизацию состояния между всеми модулями.
 */

class AppState {
  constructor() {
    this._isHosting = false;
    this._isConnecting = false;
    this._mainWindow = null;
    this._signalingWs = null;
    this._hostId = null;
    this._clientId = null;
    this._listeners = new Map();
  }

  // === Getters ===
  get isHosting() { return this._isHosting; }
  get isConnecting() { return this._isConnecting; }
  get mainWindow() { return this._mainWindow; }
  get signalingWs() { return this._signalingWs; }
  get hostId() { return this._hostId; }
  get clientId() { return this._clientId; }

  // === Setters with notifications ===
  set isHosting(value) {
    if (this._isHosting !== value) {
      console.log(`[state] isHosting changed from ${this._isHosting} to ${value}`);
      this._isHosting = value;
      this._notifyListeners('isHosting', value);
    }
  }

  set isConnecting(value) {
    if (this._isConnecting !== value) {
      console.log(`[state] isConnecting changed from ${this._isConnecting} to ${value}`);
      this._isConnecting = value;
      this._notifyListeners('isConnecting', value);
    }
  }

  set mainWindow(value) {
    this._mainWindow = value;
    this._notifyListeners('mainWindow', value);
  }

  set signalingWs(value) {
    this._signalingWs = value;
    this._notifyListeners('signalingWs', value);
  }

  set hostId(value) {
    this._hostId = value;
    this._notifyListeners('hostId', value);
  }

  set clientId(value) {
    this._clientId = value;
    this._notifyListeners('clientId', value);
  }

  // === State management methods ===
  
  /**
   * Устанавливает состояние хоста
   */
  setHosting(hostId) {
    this.isConnecting = false;
    this.isHosting = true;
    this.hostId = hostId;
    this.clientId = null;
  }

  /**
   * Устанавливает состояние клиента
   */
  setConnecting(clientId) {
    this.isHosting = false;
    this.isConnecting = true;
    this.clientId = clientId;
    this.hostId = null;
  }

  /**
   * Сбрасывает состояние подключения
   */
  resetConnection() {
    this.isHosting = false;
    this.isConnecting = false;
    this.hostId = null;
    this.clientId = null;
  }

  /**
   * Проверяет, подключено ли приложение к чему-либо
   */
  isConnected() {
    return this.isHosting || this.isConnecting;
  }

  // === Event listeners ===
  
  /**
   * Добавляет слушателя изменений состояния
   */
  addListener(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(callback);
  }

  /**
   * Удаляет слушателя изменений состояния
   */
  removeListener(event, callback) {
    if (this._listeners.has(event)) {
      const listeners = this._listeners.get(event);
      const index = listeners.indexOf(callback);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  /**
   * Уведомляет всех слушателей об изменении
   */
  _notifyListeners(event, value) {
    if (this._listeners.has(event)) {
      this._listeners.get(event).forEach(callback => {
        try {
          callback(value);
        } catch (error) {
          console.error(`Error in state listener for ${event}:`, error);
        }
      });
    }
  }

  // === Debug methods ===
  
  /**
   * Выводит текущее состояние в консоль
   */
  logState() {
    console.log('📊 Current App State:', {
      isHosting: this.isHosting,
      isConnecting: this.isConnecting,
      hostId: this.hostId,
      clientId: this.clientId,
      hasMainWindow: !!this.mainWindow,
      hasSignalingWs: !!this.signalingWs
    });
  }
}

// Создаем единственный экземпляр состояния
const appState = new AppState();

module.exports = appState; 