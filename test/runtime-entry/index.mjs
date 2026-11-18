import { DurableObject } from 'cloudflare:workers';
import worker,{EditorialJobCore,EditorialBudgetCore} from '../../src/worker.mjs';
export default worker;
export class EditorialJob extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.core=new EditorialJobCore(ctx,env);}
  fetch(request){return this.core.fetch(request);}
  alarm(){return this.core.alarm();}
}
export class EditorialBudget extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.core=new EditorialBudgetCore(ctx,env);}
  fetch(request){return this.core.fetch(request);}
}
