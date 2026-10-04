import { COMMAND_SHOW_OUTPUT } from '../constants';
import * as output from '../ui/output';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_SHOW_OUTPUT,

  handleCommand() {
    output.show();
  },
});
