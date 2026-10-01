import { COMMAND_CANCEL_ALL_TRANSFER } from '../constants';
import { checkCommand } from './abstract/createCommand';
import { findAllFileService } from '../modules/serviceManager';
import { activityStore, groupIsActive } from '../modules/activity';

export default checkCommand({
  id: COMMAND_CANCEL_ALL_TRANSFER,

  async handleCommand() {
    for (const group of activityStore.groups.values()) if (groupIsActive(group)) activityStore.cancel(group.id);
    findAllFileService(f => f.isTransferring()).forEach(f => f.cancelTransferTasks());
  },
});
