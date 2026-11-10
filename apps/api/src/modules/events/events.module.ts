import { Module } from '@nestjs/common';
import { UsersRepository } from '../users/users.repository';
import { EventsController } from './events.controller';
import { EventsRepository } from './events.repository';
import { EventsService } from './events.service';

@Module({
  controllers: [EventsController],
  providers: [EventsRepository, EventsService, UsersRepository],
  exports: [EventsRepository],
})
export class EventsModule {}
